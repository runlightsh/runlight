// Package runlightchi serves Runlight from a chi router: the link domains
// added in Settings, the dashboard and API under the routes' base path, the
// OAuth documents MCP clients look for at the site's root, and short links
// on the app's own domain.
//
//	rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}})
//	routes, err := rl.Routes(runlight.RoutesOptions{})
//	r := chi.NewRouter()
//	r.Use(rl.Observer)
//	runlightchi.Mount(r, rl, routes)
package runlightchi

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	runlight "runlight.sh/go"
)

// Mount adds Runlight to r: middleware that answers the link domains added
// in Settings before the app's own routes, the routes at their base path and
// everything below it, the OAuth discovery documents, and GET
// {LinkPath}/{slug} for short links, where a slug no link has goes to r's
// NotFound handler, so the app's own 404 page answers it.
//
// Mount it on the top router, since the routes read the full path, and
// before the app's own routes: a link domain answers every path on it,
// before any route of the app's, and chi takes middleware only until the
// first route. Mounted after a route it panics, as chi does for middleware
// after routes, rather than leave a link domain's short links to whichever
// paths the app happens not to route. An app that must add its routes first
// can leave link domains to rl.LinkDomains around the whole router instead,
// http.ListenAndServe(addr, rl.LinkDomains(r)), and add the rest with
// MountRoutes.
func Mount(r chi.Router, rl *runlight.Runlight, routes *runlight.Routes) {
	linkDomains(r, rl)
	MountRoutes(r, rl, routes)
}

// MountRoutes is Mount without the middleware for link domains, which the
// app then puts around its router with rl.LinkDomains. It can come after
// the app's own routes.
func MountRoutes(r chi.Router, rl *runlight.Runlight, routes *runlight.Routes) {
	base := routes.Base()
	r.Handle(base+"/*", routes)
	if base != "" {
		r.Handle(base, routes)
		for _, document := range runlight.OAuthDocuments {
			r.Handle(document, routes)
			r.Handle(document+"/*", routes)
		}
	}
	// Read when a request comes, so a NotFound the app sets after this still counts.
	notFound := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if mux, ok := r.(interface{ NotFoundHandler() http.HandlerFunc }); ok {
			mux.NotFoundHandler()(w, req)
			return
		}
		http.NotFound(w, req)
	})
	r.Method("GET", rl.LinkPath+"/{slug}", rl.LinksHTTPOr(notFound))
}

// linkDomains puts rl.LinkDomains in front of r's routes, or panics with the
// way to do it on a router that already has routes, which chi refuses
// middleware.
func linkDomains(r chi.Router, rl *runlight.Runlight) {
	defer func() {
		refused := recover()
		if refused == nil {
			return
		}
		if !strings.Contains(fmt.Sprint(refused), "middlewares must be defined before routes") {
			panic(refused)
		}
		panic("runlightchi: Mount must come before the app's own routes, since a link domain answers every path on it and chi takes middleware only until the first route. " +
			"Call runlightchi.Mount first, or wrap the whole router with rl.LinkDomains (http.ListenAndServe(addr, rl.LinkDomains(r))) and call runlightchi.MountRoutes.")
	}()
	r.Use(rl.LinkDomains)
}
