<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\TestCase;
use Runlight\Json;
use Runlight\Time;

/** The TypeScript SDK's time tests, then the fixture written from it. */
final class TimeTest extends TestCase
{
    private static function iso(int $ms): string
    {
        return gmdate('Y-m-d\TH:i:s', intdiv($ms, 1000)) . sprintf('.%03dZ', $ms % 1000);
    }

    private static function utc(int $y, int $m, int $d = 1, int $h = 0, int $i = 0): int
    {
        return gmmktime($h, $i, 0, $m + 1, $d, $y) * 1000;
    }

    public function testALocalDayStartsAtLocalMidnight(): void
    {
        $this->assertSame('2026-06-30T23:00:00.000Z', self::iso(Time::startOf('2026-07-01', 'Europe/London')));
        $this->assertSame('2026-01-15T05:00:00.000Z', self::iso(Time::startOf('2026-01-15', 'America/Toronto')));
        $this->assertSame('2026-01-14T18:30:00.000Z', self::iso(Time::startOf('2026-01-15', 'Asia/Kolkata')));
        $this->assertSame('2026-01-15T00:00:00.000Z', self::iso(Time::startOf('2026-01-15', 'UTC')));
    }

    public function testTheSpringDstChangeMakesA23HourDay(): void
    {
        $range = Time::resolveRange(['from' => '2026-03-07', 'to' => '2026-03-09'], 'America/Toronto', self::utc(2026, 2, 10));
        $days = Time::buckets($range, 'America/Toronto');
        $this->assertCount(3, $days);
        $this->assertSame([24, 23, 24], array_map(fn ($d) => intdiv($d['end'] - $d['start'], 3_600_000), $days));
    }

    public function testNamedPeriodsResolveInTheSitesTimezone(): void
    {
        $now = self::utc(2026, 9, 6, 2); // 2026-10-06 02:00 UTC is still the 5th in Toronto
        $this->assertSame('2026-10-05', Time::localDate($now, 'America/Toronto'));
        $today = Time::resolveRange(['period' => 'today'], 'America/Toronto', $now);
        $this->assertSame('2026-10-05', $today['fromDate']);
        $this->assertSame('hour', $today['interval']);
        $week = Time::resolveRange(['period' => '7d'], 'UTC', $now);
        $this->assertSame('2026-09-30', $week['fromDate']);
        $this->assertSame('2026-10-06', $week['toDate']);
        $lastMonth = Time::resolveRange(['period' => 'last_month'], 'UTC', $now);
        $this->assertSame(['2026-09-01', '2026-09-30'], [$lastMonth['fromDate'], $lastMonth['toDate']]);
        $this->assertSame('month', Time::resolveRange(['period' => '12mo'], 'UTC', $now)['interval']);
        $this->assertNull(Time::resolveRange(['period' => 'nope'], 'UTC', $now));
        $this->assertNull(Time::resolveRange(['from' => '2026-10-05', 'to' => '2026-10-01'], 'UTC', $now));
        $this->assertNull(Time::resolveRange(['from' => '2026-02-30', 'to' => '2026-03-01'], 'UTC', $now));
    }

    public function testAnIntervalTooFineForALongRangeMovesUpToOneThatFitsAndNoBucketTakesInTheRest(): void
    {
        $now = self::utc(2026, 9, 12, 12);
        $day = 86_400_000;
        $hourly = Time::resolveRange(['from' => '2026-08-01', 'to' => '2026-09-09', 'interval' => 'hour'], 'UTC', $now);
        $this->assertSame('day', $hourly['interval']);
        $this->assertCount(40, Time::buckets($hourly, 'UTC'));
        $this->assertSame('hour', Time::resolveRange(['from' => '2026-08-01', 'to' => '2026-08-31', 'interval' => 'hour'], 'UTC', $now)['interval']);

        $daily = Time::resolveRange(['from' => '2018-01-03', 'to' => '2026-10-12', 'interval' => 'day'], 'Europe/London', $now);
        $this->assertSame('week', $daily['interval']);
        $weeks = Time::buckets($daily, 'Europe/London');
        $this->assertSame($daily['from'], $weeks[0]['start']);
        $this->assertSame($daily['to'], $weeks[count($weeks) - 1]['end'], 'the buckets reach the end of the range');
        foreach ($weeks as $i => $week) {
            if ($i > 0) {
                $this->assertSame($weeks[$i - 1]['end'], $week['start']);
            }
            $this->assertLessThanOrEqual(7 * $day + 3_600_000, $week['end'] - $week['start'], "week $i");
            if ($i > 0 && $i < count($weeks) - 1) {
                $this->assertGreaterThanOrEqual(7 * $day - 3_600_000, $week['end'] - $week['start']);
            }
        }

        $decades = Time::resolveRange(['from' => '1990-01-01', 'to' => '2026-10-12', 'interval' => 'day'], 'UTC', $now);
        $this->assertSame('month', $decades['interval']);
        $months = Time::buckets($decades, 'UTC');
        $this->assertCount(442, $months);
        foreach ($months as $month) {
            $this->assertLessThanOrEqual(31 * $day, $month['end'] - $month['start']);
        }
        $this->assertNull(Time::resolveRange(['from' => '1900-01-01', 'to' => '2026-10-12'], 'UTC', $now), 'past 1,000 months there is no interval that fits');

        // A comparison longer than its range keeps whole buckets, cut off at a boundary.
        $longer = ['from' => self::utc(2000, 0, 1), 'fromDate' => '2000-01-01', 'toDate' => '2026-10-12', 'interval' => 'day'] + $decades;
        $cut = Time::buckets($longer, 'UTC');
        $this->assertCount(1000, $cut);
        $this->assertSame($day, $cut[999]['end'] - $cut[999]['start']);
    }

    public function testMonthBucketsStartOnTheFirst(): void
    {
        $range = Time::resolveRange(['from' => '2026-01-15', 'to' => '2026-03-10', 'interval' => 'month'], 'UTC', self::utc(2026, 3, 1));
        $months = Time::buckets($range, 'UTC');
        $this->assertCount(3, $months);
        $this->assertSame('2026-01-15T00:00:00.000Z', self::iso($months[0]['start']));
        $this->assertSame('2026-02-01T00:00:00.000Z', self::iso($months[1]['start']));
        $this->assertSame('2026-03-11T00:00:00.000Z', self::iso($months[2]['end']));
    }

    public function testComparisonRangesPreviousAYearBackCustomAndOff(): void
    {
        $now = self::utc(2026, 9, 6, 12);
        $week = Time::resolveRange(['period' => '7d'], 'UTC', $now);
        $prev = Time::compareRange($week, 'previous', 'UTC');
        $this->assertSame(['2026-09-23', '2026-09-29'], [$prev['fromDate'], $prev['toDate']]);
        $this->assertSame($week['from'], $prev['to']);
        $year = Time::compareRange($week, 'year', 'UTC');
        $this->assertSame(['2025-09-30', '2025-10-06'], [$year['fromDate'], $year['toDate']]);
        $leap = Time::compareRange(Time::resolveRange(['from' => '2028-02-29', 'to' => '2028-02-29'], 'UTC', $now), 'year', 'UTC');
        $this->assertSame('2027-02-28', $leap['fromDate']);
        $custom = Time::compareRange($week, 'custom', 'UTC', ['from' => '2026-01-01', 'to' => '2026-01-07']);
        $this->assertSame('2026-01-01', $custom['fromDate']);
        $this->assertNull(Time::compareRange($week, 'custom', 'UTC', ['from' => '2026-01-07', 'to' => '2026-01-01']));
        $this->assertNull(Time::compareRange($week, 'off', 'UTC'));
    }

    public function testADayWhoseMidnightIsSkippedByTheClocksBeginsWhenTheyLand(): void
    {
        // Santiago, Havana, and the Azores move their clocks forward at midnight.
        foreach ([
            ['2026-09-06', 'America/Santiago', '2026-09-06T04:00:00.000Z'],
            ['2026-03-08', 'America/Havana', '2026-03-08T05:00:00.000Z'],
            ['2026-03-29', 'Atlantic/Azores', '2026-03-29T01:00:00.000Z'],
        ] as [$date, $zone, $start]) {
            $at = Time::startOf($date, $zone);
            $this->assertSame($start, self::iso($at), $zone);
            $this->assertSame($date, Time::localDate($at, $zone));
            $this->assertNotSame($date, Time::localDate($at - 1, $zone));
        }
    }

    public function testADayWhereClocksFallBackAcrossMidnightBeginsAtTheFirstMidnight(): void
    {
        // Amman in 2019, Gaza and Hebron in 2020, an hour each, and three hours at Casey station in 2019.
        foreach ([['2019-10-25', 'Asia/Amman'], ['2020-10-24', 'Asia/Gaza'], ['2020-10-24', 'Asia/Hebron'], ['2019-03-17', 'Antarctica/Casey']] as [$date, $zone]) {
            $start = Time::startOf($date, $zone);
            $this->assertSame($date, Time::localDate($start, $zone), $zone);
            $this->assertLessThan($date, Time::localDate($start - 1, $zone), "$zone: the moment before is the day before");
        }
    }

    public function testADateWithAMonthOrDayThatDoesNotExistIsNotADate(): void
    {
        foreach (['2026-13-01', '2026-00-05', '2026-02-30', '2026-04-31', '2026-1-01', '9999-12-31', '0001-01-01'] as $bad) {
            $this->assertFalse(Time::isDate($bad), $bad);
        }
        $this->assertTrue(Time::isDate('2028-02-29'));
    }

    /**
     * ICU's System V zones with summer time keep the United States rules of their day, which no zone in
     * PHP's database has; their names are taken, and they follow today's rules here.
     */
    private const SYSTEM_V_SUMMER = ['systemv/ast4adt', 'systemv/est5edt', 'systemv/cst6cdt', 'systemv/mst7mdt', 'systemv/pst8pdt', 'systemv/yst9ydt'];

    /**
     * The fixture came from Node's ICU with time zone data 2025c. PHP's copy of the data may be newer, and
     * disagree wherever a zone's rules changed since (British Columbia, Alberta, and Manitoba keeping summer time,
     * Morocco's Ramadan dates): these zones' instants from 2026 on are not compared, and every other zone must match.
     */
    private const CHANGED_SINCE_2025C = [
        'America/Vancouver', 'Canada/Pacific', 'America/Edmonton', 'America/Inuvik', 'America/Yellowknife', 'Canada/Mountain',
        'America/Winnipeg', 'America/Rainy_River', 'Canada/Central', 'Africa/Casablanca', 'Africa/El_Aaiun',
    ];

    /**
     * 2025c corrected Baja California's clocks in the 1970s, so with older data (as PECL timezonedb 2025.2 has)
     * these zones' instants before 1980 are not compared.
     */
    private const HISTORY_FIXED_IN_2025C = ['America/Tijuana', 'America/Ensenada', 'America/Santa_Isabel', 'Mexico/BajaNorte'];

    private static function changed(string $zone, int $ts): bool
    {
        if (in_array($zone, self::HISTORY_FIXED_IN_2025C, true) && $ts < self::utc(1980, 0) && version_compare(timezone_version_get(), '2025.3', '<')) {
            return true;
        }
        return in_array($zone, self::CHANGED_SINCE_2025C, true) && $ts >= self::utc(2026, 0);
    }

    public function testZones(): void
    {
        $fixture = Fixture::load('time');
        $failures = [];
        // Before 1970 ICU follows the time zone database's backzone history, where zones that are now
        // links (Africa/Bamako, Europe/Oslo) kept their own clocks; PHP's database has only the links, so
        // instants before 1970 are compared for the focus zones alone, in testInstantsAroundEveryOffsetChange.
        $since1970 = array_filter($fixture['sampleTimes'], fn (int $ts) => $ts >= 0);
        foreach ($fixture['zones'] as $zone) {
            $valid = Time::isTimezone($zone['name']);
            if ($valid !== $zone['valid']) {
                $failures[] = $zone['name'] . ($valid ? ' taken' : ' refused');
                continue;
            }
            if (!$valid || in_array(strtolower($zone['name']), self::SYSTEM_V_SUMMER, true)) {
                continue;
            }
            foreach ($since1970 as $i => $ts) {
                if (self::changed($zone['name'], $ts)) {
                    continue;
                }
                $local = Time::localDate($ts, $zone['name']) . ' ' . implode(' ', Time::localWeekdayHour($ts, $zone['name']));
                if ($local !== $zone['local'][$i]) {
                    $failures[] = "{$zone['name']} at $ts: $local not {$zone['local'][$i]}";
                }
            }
        }
        $this->assertGreaterThan(600, count($fixture['zones']));
        $this->assertSame([], $failures);
    }

    public function testInstantsAroundEveryOffsetChange(): void
    {
        $failures = [];
        $instants = Fixture::load('time')['instants'];
        foreach ($instants as [$zone, $ts, $date, $weekday, $hour]) {
            if (self::changed($zone, $ts)) {
                continue;
            }
            $got = [Time::localDate($ts, $zone), ...Time::localWeekdayHour($ts, $zone)];
            if ($got !== [$date, $weekday, $hour]) {
                $failures[] = "$zone $ts: " . implode(' ', $got) . " not $date $weekday $hour";
            }
        }
        $this->assertGreaterThan(10000, count($instants));
        $this->assertSame([], array_slice($failures, 0, 30));
    }

    public function testDayStarts(): void
    {
        $fixture = Fixture::load('time');
        $failures = [];
        foreach ($fixture['starts'] as [$zone, $date, $hour, $start]) {
            if (self::changed($zone, $start)) {
                continue;
            }
            $got = Time::startOf($date, $zone, $hour);
            if ($got !== $start) {
                $failures[] = "$zone $date $hour: $got not $start";
            }
        }
        foreach ($fixture['dayStarts'] as [$zone, $year, $sha]) {
            if (self::changed($zone, self::utc($year, 11, 31))) {
                continue;
            }
            $days = [];
            for ($d = "$year-01-01"; strcmp($d, ($year + 1) . '-01-01') < 0; $d = Time::addDays($d, 1)) {
                $days[] = Time::startOf($d, $zone);
            }
            if (hash('sha256', Json::encode($days)) !== $sha) {
                $failures[] = "$zone $year: every day's start";
            }
        }
        $this->assertSame([], array_slice($failures, 0, 30));
    }

    public function testDateMath(): void
    {
        foreach (Fixture::load('time')['dates'] as $case) {
            $date = $case['date'];
            $this->assertSame($case['isDate'], Time::isDate($date), $date);
            if ($case['plus'] !== null) {
                $this->assertSame($case['plus'], array_map(fn ($n) => Time::addDays($date, $n), [-400, -366, -365, -31, -1, 0, 1, 28, 29, 31, 365, 366, 1000]), $date);
                $this->assertSame($case['months'], array_map(fn ($n) => Time::addMonths($date, $n), [-25, -12, -11, -1, 0, 1, 11, 12, 13]), $date);
            }
        }
        $this->assertSame(Fixture::load('time')['periods'], Time::PERIODS);
    }

    public function testRangesAndBuckets(): void
    {
        $failures = [];
        $ranges = Fixture::load('time')['ranges'];
        foreach ($ranges as $case) {
            $range = Time::resolveRange($case['input'], $case['zone'], $case['now'], $case['firstDate']);
            $got = ['range' => $range];
            $want = ['range' => $case['range']];
            if ($range !== null) {
                $buckets = Time::buckets($range, $case['zone']);
                $got['buckets'] = ['count' => count($buckets), 'first' => $buckets[0] ?? null, 'sha256' => hash('sha256', Json::encode($buckets))];
                $want['buckets'] = $case['buckets'];
                if (isset($case['compare'])) {
                    $got['compare'] = [];
                    foreach (['previous', 'year', 'off', 'custom', 'nope'] as $mode) {
                        $got['compare'][$mode] = Time::compareRange($range, $mode, $case['zone'], ['from' => '2025-02-28', 'to' => '2025-03-31']);
                    }
                    $want['compare'] = $case['compare'];
                }
            }
            if ($got !== $want) {
                $failures[] = Fixture::label([$case['zone'], $case['now'], $case['input'], $case['firstDate']]) . ' gave ' . Fixture::label($got) . ' not ' . Fixture::label($want);
            }
        }
        $this->assertGreaterThan(2000, count($ranges));
        $this->assertSame([], array_slice($failures, 0, 20));
    }

    public function testCompareRanges(): void
    {
        foreach (Fixture::load('time')['compares'] as $case) {
            $this->assertSame($case['compare'], Time::compareRange($case['range'], $case['mode'], $case['zone'], $case['custom']), Fixture::label($case));
        }
    }
}
