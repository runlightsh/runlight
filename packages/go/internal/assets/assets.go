// Package assets holds the dashboard and tracker the TypeScript SDK builds,
// copied here byte for byte by scripts/go-assets.mts, so the Go port serves
// the very same files. Never edit the files beside this one.
package assets

import (
	"bytes"
	_ "embed"
	"encoding/json"
)

var (
	//go:embed assistant-action.json
	AssistantAction string
	//go:embed dashboard.js
	DashboardJS string
	//go:embed dashboard.css
	DashboardCSS string
	//go:embed world.json
	WorldJSON string
	//go:embed tracker.js
	Tracker string
	//go:embed picker.js
	Picker string
	//go:embed pick-return.js
	PickRelay string
	//go:embed locales.json
	localesJSON []byte
	//go:embed build.json
	buildJSON []byte
	//go:embed agent-ranges.json
	agentRangesJSON []byte
)

// Build is what build.json says about the copied files.
var Build struct {
	Version       string `json:"version"`
	APIVersion    int    `json:"apiVersion"`
	DashboardHash string `json:"dashboardHash"`
	WorldHash     string `json:"worldHash"`
	LocalesHash   string `json:"localesHash"`
	TrackerHash   string `json:"trackerHash"`
	Icon          string `json:"icon"`
}

// AgentRanges is the address lists AI companies publish for their agents, as
// they were when this version was built: each list's address and its
// prefixes, such as 20.171.206.0/24.
var AgentRanges struct {
	FetchedAt string              `json:"fetchedAt"`
	Lists     map[string][]string `json:"lists"`
}

// AgentRangeOrder is the lists' addresses in the order the file has them.
var AgentRangeOrder []string

// Locales is each language's dashboard strings, as the JSON text the SDK
// holds them in; "en" is English.
var Locales map[string]string

// LocaleOrder is the languages in the order the SDK lists them: English,
// then the others.
var LocaleOrder []string

func init() {
	if err := json.Unmarshal(buildJSON, &Build); err != nil {
		panic("assets: build.json: " + err.Error())
	}
	if err := json.Unmarshal(localesJSON, &Locales); err != nil {
		panic("assets: locales.json: " + err.Error())
	}
	if err := json.Unmarshal(agentRangesJSON, &AgentRanges); err != nil {
		panic("assets: agent-ranges.json: " + err.Error())
	}
	AgentRangeOrder = keysInOrder(agentRangesJSON, "lists")
	// locales.json is written with English first and the rest in the SDK's own order.
	dec := json.NewDecoder(bytes.NewReader(localesJSON))
	_, _ = dec.Token()
	for dec.More() {
		key, _ := dec.Token()
		LocaleOrder = append(LocaleOrder, key.(string))
		var skip json.RawMessage
		_ = dec.Decode(&skip)
	}
}

// keysInOrder is the keys of the object at field of a JSON object, in the order they are written.
func keysInOrder(text []byte, field string) []string {
	var outer map[string]json.RawMessage
	if json.Unmarshal(text, &outer) != nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(outer[field]))
	if _, err := dec.Token(); err != nil {
		return nil
	}
	var keys []string
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return keys
		}
		keys = append(keys, key.(string))
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}
