package web

import (
	"context"
	"errors"
	"testing"
)

// A Fetcher other than the built-in one may not honour PublicOnly, so a name
// that resolves to a private address never reaches it.
func TestPublicFetchLooksUpNamesForOtherFetchers(t *testing.T) {
	was := Resolver
	defer func() { Resolver = was }()
	Resolver = func(_ context.Context, name string) ([]string, error) {
		switch name {
		case "inside.example":
			return []string{"93.184.216.34", "10.0.0.1"}, nil
		case "outside.example":
			return []string{"93.184.216.34"}, nil
		}
		return nil, errors.New("no such host")
	}
	var asked []string
	fetcher := FetchFunc(func(_ context.Context, url string, _ FetchInit) (*Response, error) {
		asked = append(asked, url)
		return NewResponse(200, []byte("ok")), nil
	})
	_, err := PublicFetch(context.Background(), fetcher, "https://inside.example/", FetchInit{}, 0)
	var private *PrivateAddressError
	if !errors.As(err, &private) {
		t.Fatalf("inside.example: %v, want a PrivateAddressError", err)
	}
	for _, target := range []string{"https://outside.example/", "https://unknown.example/"} {
		if _, err := PublicFetch(context.Background(), fetcher, target, FetchInit{}, 0); err != nil {
			t.Fatalf("%s: %v", target, err)
		}
	}
	if len(asked) != 2 || asked[0] != "https://outside.example/" || asked[1] != "https://unknown.example/" {
		t.Fatalf("fetched %v", asked)
	}
}
