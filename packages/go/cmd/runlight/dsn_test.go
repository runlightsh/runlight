package main

import "testing"

func TestAMySQLURLCarriesItsTLSSettingAndAskedHostsAreOfferedTLSByDefault(t *testing.T) {
	for url, want := range map[string]string{
		"mysql://u:p@127.0.0.1/db":                               "u:p@tcp(127.0.0.1:3306)/db?charset=utf8mb4&loc=UTC",
		"mysql://u:p@localhost:3307/db":                          "u:p@tcp(localhost:3307)/db?charset=utf8mb4&loc=UTC",
		"mysql://u:p@[::1]/db":                                   "u:p@tcp([::1]:3306)/db?charset=utf8mb4&loc=UTC",
		"mysql://u:p@db.example.com/db":                          "u:p@tcp(db.example.com:3306)/db?charset=utf8mb4&loc=UTC&tls=preferred",
		"mariadb://u:p@db.example.com:3307/db":                   "u:p@tcp(db.example.com:3307)/db?charset=utf8mb4&loc=UTC&tls=preferred",
		"mysql://u:p@db.example.com/db?tls=true":                 "u:p@tcp(db.example.com:3306)/db?charset=utf8mb4&loc=UTC&tls=true",
		"mysql://u:p@db.example.com/db?tls=skip-verify":          "u:p@tcp(db.example.com:3306)/db?charset=utf8mb4&loc=UTC&tls=skip-verify",
		"mysql://u:p@db.example.com/db?tls=false":                "u:p@tcp(db.example.com:3306)/db?charset=utf8mb4&loc=UTC&tls=false",
		"mysql://u:p@db.example.com/db?ssl-mode=REQUIRED":        "u:p@tcp(db.example.com:3306)/db?charset=utf8mb4&loc=UTC&tls=skip-verify",
		"mysql://u:p@db.example.com/db?ssl-mode=VERIFY_IDENTITY": "u:p@tcp(db.example.com:3306)/db?charset=utf8mb4&loc=UTC&tls=true",
		"mysql://u:p@db.example.com/db?ssl-mode=DISABLED":        "u:p@tcp(db.example.com:3306)/db?charset=utf8mb4&loc=UTC&tls=false",
		"mysql://u:p@127.0.0.1/db?ssl-mode=REQUIRED":             "u:p@tcp(127.0.0.1:3306)/db?charset=utf8mb4&loc=UTC&tls=skip-verify",
	} {
		got, err := mysqlDSN(url)
		if err != nil || got != want {
			t.Errorf("%s: %q %v, want %q", url, got, err, want)
		}
	}
	for _, url := range []string{"mysql://u:p@db.example.com/db?tls=maybe", "mysql://u:p@db.example.com/db?ssl-mode=LOUD"} {
		if got, err := mysqlDSN(url); err == nil {
			t.Errorf("%s: %q should be refused", url, got)
		}
	}
}
