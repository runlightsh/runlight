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

// Link-local and cloud metadata addresses are told apart from loopback and private ones.
func TestMetadataAddresses(t *testing.T) {
	for _, ip := range []string{"169.254.169.254", "169.254.0.1", "100.100.100.200", "fe80::1", "fe80::a9fe:a9fe", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe"} {
		if !MetadataAddress(ip) {
			t.Errorf("%s is a metadata address", ip)
		}
	}
	for _, ip := range []string{"127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "fd00::1", "fd00:ec2::253", "93.184.215.14", "not an address"} {
		if MetadataAddress(ip) {
			t.Errorf("%s is not a metadata address", ip)
		}
	}
	was := Resolver
	defer func() { Resolver = was }()
	Resolver = func(_ context.Context, name string) ([]string, error) {
		switch name {
		case "localhost":
			return []string{"127.0.0.1", "::1"}, nil
		case "points.example":
			return []string{"93.184.216.34", "169.254.169.254"}, nil
		}
		return nil, errors.New("no such host")
	}
	ctx := context.Background()
	for host, want := range map[string]bool{"metadata.google.internal": true, "[fd00:ec2::254]": true, "169.254.169.254": true, "points.example": true,
		"localhost": false, "192.168.1.20": false, "unknown.example": false} {
		if MetadataHost(ctx, host) != want {
			t.Errorf("MetadataHost(%q) is not %v", host, want)
		}
	}
}
