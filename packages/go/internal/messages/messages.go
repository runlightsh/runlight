// Package messages holds the dashboard's translations for text the server writes: email reports, and the account
// and OAuth pages. Same keys, same placeholders, so every language stays in one place.
package messages

import (
	"regexp"
	"strings"
	"sync"

	"runlight.sh/go/internal/assets"
	"runlight.sh/go/internal/js"
)

var (
	mu     sync.Mutex
	tables = map[string]map[string]string{}
)

// Table is every message of a language, by key; empty for one the dashboard does not speak.
func Table(lang string) map[string]string {
	mu.Lock()
	defer mu.Unlock()
	if found, ok := tables[lang]; ok {
		return found
	}
	found := map[string]string{}
	if raw, ok := assets.Locales[lang]; ok {
		if v, err := js.Parse(raw); err == nil {
			js.Obj(v).Each(func(k string, v any) { found[k] = js.Str(v) })
		}
	}
	tables[lang] = found
	return found
}

// Languages are the languages the dashboard, the email reports, and the server's pages come in.
func Languages() []string { return assets.LocaleOrder }

// Accepted is the first language an Accept-Language header asks for that the dashboard speaks, else English.
func Accepted(header string) string {
	for _, part := range strings.Split(header, ",") {
		code := strings.ToLower(js.Head16(js.Trim(strings.Split(part, ";")[0]), 2))
		for _, l := range Languages() {
			if l == code {
				return code
			}
		}
	}
	return "en"
}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

// Translator writes messages in one language.
type Translator struct {
	Lang string
}

// New is the translator for a language, English for one there is none of.
func New(lang string) Translator {
	for _, l := range Languages() {
		if l == lang {
			return Translator{lang}
		}
	}
	return Translator{"en"}
}

func (tr Translator) raw(key string) string {
	if text, ok := Table(tr.Lang)[key]; ok {
		return text
	}
	if text, ok := Table("en")[key]; ok {
		return text
	}
	return key
}

func fill(text string, vars map[string]string) string {
	return placeholder.ReplaceAllStringFunc(text, func(m string) string {
		if v, ok := vars[m[1:len(m)-1]]; ok {
			return v
		}
		return m
	})
}

// T is a message, its placeholders filled; the key itself when no language has it.
func (tr Translator) T(key string, vars map[string]string) string { return fill(tr.raw(key), vars) }

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// HTML is a message for a page: its own text escaped, then each {name} filled with HTML the caller made safe.
func (tr Translator) HTML(key string, vars map[string]string) string {
	return fill(htmlEscaper.Replace(tr.raw(key)), vars)
}
