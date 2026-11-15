//! Values bound to a Postgres statement as the TypeScript's driver binds them: untyped, so the server works
//! out each one's type from where it stands in the statement, as it does for node-postgres.
//!
//! sqlx sends every parameter in Postgres's binary form, under a type it takes from the Rust value, where
//! node-postgres sends text and names no type. So a statement is prepared first with no types named, the
//! types the server chose are read back, and each value is then written in binary for the type it was
//! given: a number for a BIGINT column, text for a TEXT one, whichever the value itself was.

use runlight::js;
use runlight::store::{DbError, Param};
use sqlx::encode::IsNull;
use sqlx::error::BoxDynError;
use sqlx::postgres::{PgArgumentBuffer, PgArguments, PgTypeInfo, Postgres};

/// One value, and the type the server gave its place in the statement.
struct Bound<'a> {
    kind: PgTypeInfo,
    value: &'a Param,
}

impl sqlx::Type<Postgres> for Bound<'_> {
    /// Never used: each value says its own type, in `produces`.
    fn type_info() -> PgTypeInfo {
        <str as sqlx::Type<Postgres>>::type_info()
    }

    fn compatible(_: &PgTypeInfo) -> bool {
        true
    }
}

impl<'q> sqlx::Encode<'q, Postgres> for Bound<'_> {
    fn encode_by_ref(&self, buf: &mut PgArgumentBuffer) -> Result<IsNull, BoxDynError> {
        match binary(&self.kind, self.value)? {
            Some(bytes) => {
                buf.extend_from_slice(&bytes);
                Ok(IsNull::No)
            }
            None => Ok(IsNull::Yes),
        }
    }

    fn produces(&self) -> Option<PgTypeInfo> {
        Some(self.kind.clone())
    }
}

/// The values of a statement as its arguments, each under the type the server chose for it.
pub(crate) fn arguments(kinds: &[PgTypeInfo], params: &[Param]) -> Result<PgArguments, DbError> {
    use sqlx::Arguments;
    if kinds.len() != params.len() {
        return Err(DbError(format!(
            "Runlight: a statement takes {} values and was given {}",
            kinds.len(),
            params.len()
        )));
    }
    let mut args = PgArguments::default();
    for (kind, value) in kinds.iter().zip(params) {
        args.add(Bound { kind: kind.clone(), value }).map_err(|e| DbError(e.to_string()))?;
    }
    Ok(args)
}

/// A value as text, as node-postgres sends it.
fn text(value: &Param) -> Option<String> {
    match value {
        Param::Null => None,
        Param::Int(n) => Some(n.to_string()),
        Param::Float(f) => Some(js::format_number(*f)),
        Param::Text(s) => Some(s.clone()),
    }
}

fn refused(kind: &str, text: &str) -> BoxDynError {
    // The words Postgres has for text it cannot read as a type.
    format!("invalid input syntax for type {kind}: \"{text}\"").into()
}

/// A value in Postgres's binary form for a type, or `None` for NULL. Text is read as the server reads the
/// text node-postgres sends: "42" is a number where a number is wanted, and 42 is text where text is.
fn binary(kind: &PgTypeInfo, value: &Param) -> Result<Option<Vec<u8>>, BoxDynError> {
    let Some(text) = text(value) else { return Ok(None) };
    let oid = kind.oid().map(|oid| oid.0);
    let whole = |name: &str| -> Result<i64, BoxDynError> {
        match value {
            Param::Int(n) => Ok(*n),
            _ => text.trim().parse::<i64>().map_err(|_| refused(name, &text)),
        }
    };
    let out_of_range =
        |name: &str| -> BoxDynError { format!("value \"{text}\" is out of range for type {name}").into() };
    let float = |name: &str| -> Result<f64, BoxDynError> {
        match value {
            Param::Int(n) => Ok(*n as f64),
            Param::Float(f) => Ok(*f),
            _ => match text.trim().to_ascii_lowercase().as_str() {
                "nan" => Ok(f64::NAN),
                "infinity" | "+infinity" | "inf" | "+inf" => Ok(f64::INFINITY),
                "-infinity" | "-inf" => Ok(f64::NEG_INFINITY),
                plain => plain.parse::<f64>().map_err(|_| refused(name, &text)),
            },
        }
    };
    Ok(Some(match oid {
        // bool
        Some(16) => match text.trim().to_ascii_lowercase().as_str() {
            "t" | "true" | "y" | "yes" | "on" | "1" => vec![1],
            "f" | "false" | "n" | "no" | "off" | "0" => vec![0],
            _ => return Err(refused("boolean", &text)),
        },
        // int8
        Some(20) => whole("bigint")?.to_be_bytes().to_vec(),
        // int2
        Some(21) => i16::try_from(whole("smallint")?).map_err(|_| out_of_range("smallint"))?.to_be_bytes().to_vec(),
        // int4
        Some(23) => i32::try_from(whole("integer")?).map_err(|_| out_of_range("integer"))?.to_be_bytes().to_vec(),
        // oid
        Some(26) => u32::try_from(whole("oid")?).map_err(|_| out_of_range("oid"))?.to_be_bytes().to_vec(),
        // float4, float8
        Some(700) => (float("real")? as f32).to_be_bytes().to_vec(),
        Some(701) => float("double precision")?.to_be_bytes().to_vec(),
        // numeric
        Some(1700) => numeric(&text).ok_or_else(|| refused("numeric", &text))?,
        // text, varchar, bpchar, name, unknown, json: the text itself
        Some(25 | 1043 | 1042 | 19 | 705 | 114) => text.into_bytes(),
        // jsonb: its version, then the text
        Some(3802) => {
            let mut bytes = vec![1];
            bytes.extend_from_slice(text.as_bytes());
            bytes
        }
        _ => return Err(format!("Runlight: cannot bind a value as {kind}").into()),
    }))
}

const NUMERIC_NEGATIVE: u16 = 0x4000;
const NUMERIC_NAN: u16 = 0xC000;

/// A decimal number's text (digits, an optional point, an optional exponent, or NaN) in the binary form
/// of Postgres's NUMERIC: how many base 10,000 digits, the weight of the first, the sign, the count of
/// digits after the point, then the digits.
fn numeric(text: &str) -> Option<Vec<u8>> {
    let header = |digits: i16, weight: i16, sign: u16, scale: u16| {
        let mut out = Vec::with_capacity(8 + digits as usize * 2);
        out.extend_from_slice(&digits.to_be_bytes());
        out.extend_from_slice(&weight.to_be_bytes());
        out.extend_from_slice(&sign.to_be_bytes());
        out.extend_from_slice(&scale.to_be_bytes());
        out
    };
    let t = text.trim();
    if t.eq_ignore_ascii_case("nan") {
        return Some(header(0, 0, NUMERIC_NAN, 0));
    }
    let (negative, t) = match t.as_bytes().first()? {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let (mantissa, exponent) = match t.find(['e', 'E']) {
        Some(at) => (&t[..at], t[at + 1..].parse::<i32>().ok()?),
        None => (t, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole.bytes().chain(fraction.bytes()).all(|b| b.is_ascii_digit())
        || exponent.abs() > 1000
    {
        return None;
    }
    // The point moved by the exponent.
    let digits = format!("{whole}{fraction}");
    let point = whole.len() as i32 + exponent;
    let (whole, fraction) = if point <= 0 {
        (String::new(), format!("{}{digits}", "0".repeat(point.unsigned_abs() as usize)))
    } else if point as usize >= digits.len() {
        (format!("{digits}{}", "0".repeat(point as usize - digits.len())), String::new())
    } else {
        (digits[..point as usize].to_string(), digits[point as usize..].to_string())
    };
    let scale = u16::try_from(fraction.len()).ok()?;
    // In groups of four from the point, each way.
    let whole = format!("{}{whole}", "0".repeat((4 - whole.len() % 4) % 4));
    let fraction = format!("{fraction}{}", "0".repeat((4 - fraction.len() % 4) % 4));
    let mut groups: Vec<i16> = Vec::new();
    for part in [&whole, &fraction] {
        for chunk in part.as_bytes().chunks(4) {
            groups.push(std::str::from_utf8(chunk).ok()?.parse().ok()?);
        }
    }
    let mut weight = (whole.len() / 4) as i32 - 1;
    let leading = groups.iter().take_while(|g| **g == 0).count();
    groups.drain(..leading);
    weight -= leading as i32;
    while groups.last() == Some(&0) {
        groups.pop();
    }
    if groups.is_empty() {
        return Some(header(0, 0, 0, scale));
    }
    let mut out = header(
        i16::try_from(groups.len()).ok()?,
        i16::try_from(weight).ok()?,
        if negative { NUMERIC_NEGATIVE } else { 0 },
        scale,
    );
    for group in groups {
        out.extend_from_slice(&group.to_be_bytes());
    }
    Some(out)
}

/// The text Postgres writes for a NUMERIC it sent in binary, such as "12.50", or `None` for bytes that are
/// not one.
pub(crate) fn numeric_text(bytes: &[u8]) -> Option<String> {
    let field = |i: usize| bytes.get(i * 2..i * 2 + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    let count = field(0)? as usize;
    let weight = i32::from(field(1)? as i16);
    let sign = field(2)?;
    let scale = field(3)? as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        0 | NUMERIC_NEGATIVE => {}
        _ => return None,
    }
    if bytes.len() != 8 + count * 2 {
        return None;
    }
    let group = |i: i32| if i >= 0 && (i as usize) < count { field(4 + i as usize).unwrap_or(0) } else { 0 };
    let mut out = String::new();
    if sign == NUMERIC_NEGATIVE {
        out.push('-');
    }
    if weight < 0 {
        out.push('0');
    } else {
        for i in 0..=weight {
            if i == 0 { out.push_str(&group(i).to_string()) } else { out.push_str(&format!("{:04}", group(i))) }
        }
    }
    if scale > 0 {
        out.push('.');
        let mut fraction = String::new();
        let mut i = weight + 1;
        while fraction.len() < scale {
            fraction.push_str(&format!("{:04}", group(i)));
            i += 1;
        }
        out.push_str(&fraction[..scale]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_written_and_read_as_postgres_numeric() {
        for (text, read) in [
            ("0", "0"),
            ("1", "1"),
            ("-1", "-1"),
            ("12.5", "12.5"),
            ("12.50", "12.50"),
            ("0.001", "0.001"),
            ("-0.5", "-0.5"),
            ("10000", "10000"),
            ("123456789.000100", "123456789.000100"),
            ("1e3", "1000"),
            ("1.5e-3", "0.0015"),
            ("+7", "7"),
            (".5", "0.5"),
            ("0.00", "0.00"),
            ("NaN", "NaN"),
        ] {
            let bytes = numeric(text).unwrap_or_else(|| panic!("{text}"));
            assert_eq!(numeric_text(&bytes).as_deref(), Some(read), "{text}");
        }
        for bad in ["", "abc", "1.2.3", "--1", "1e", "e5", "1 2"] {
            assert!(numeric(bad).is_none(), "{bad}");
        }
        // As the server writes them: 12.5 is one digit of 12 and one of 5000, a weight of 0, a scale of 1.
        assert_eq!(numeric("12.5").unwrap(), [0, 2, 0, 0, 0, 0, 0, 1, 0, 12, 0x13, 0x88]);
        assert_eq!(numeric("-10000").unwrap(), [0, 1, 0, 1, 0x40, 0, 0, 0, 0, 1]);
        assert_eq!(numeric_text(&[0, 1]), None);
    }
}
