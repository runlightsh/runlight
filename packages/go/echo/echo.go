// Package runlightecho serves Runlight from an Echo app: the link domains
// added in Settings, the dashboard and API under the routes' base path, the
// OAuth documents MCP clients look for at the site's root, and short links
// on the app's own domain.
//
//	rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}})
//	routes, err := rl.Routes(runlight.RoutesOptions{})
//	e := echo.New()
//	e.Use(runlightecho.Observer(rl))
//	runlightecho.Register(e, rl, routes)
package runlightecho

import (
	"net/http"

	"github.com/labstack/echo/v5"

	runlight "runlight.sh/go"
)

// Register adds Runlight to e: middleware that answers the link domains added
// in Settings before Echo routes the request, the routes at their base path
// and everything below it, the OAuth discovery documents, and GET
// {LinkPath}/:slug for short links, where a slug no link has is
// echo.ErrNotFound, so the app's own 404 page answers it.
func Register(e *echo.Echo, rl *runlight.Runlight, routes *runlight.Routes) {
	e.Pre(echo.WrapMiddleware(rl.LinkDomains))
	handler := echo.WrapHandler(routes)
	base := routes.Base()
	e.Any(base+"/*", handler)
	if base != "" {
		e.Any(base, handler)
		for _, document := range runlight.OAuthDocuments {
			e.Any(document, handler)
			e.Any(document+"/*", handler)
		}
	}
	e.GET(rl.LinkPath+"/:slug", links(rl))
}

// links answers GET {LinkPath}/:slug, and a slug no link has (or one that is
// not valid percent-encoding) with echo.ErrNotFound, so the app's own error
// handler answers it as any other page it does not have.
func links(rl *runlight.Runlight) echo.HandlerFunc {
	return func(c *echo.Context) error {
		missed := false
		rl.LinksHTTPOr(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { missed = true })).ServeHTTP(c.Response(), c.Request())
		if missed {
			return echo.ErrNotFound
		}
		return nil
	}
}

// Observer is middleware that records AI agent fetches of the app's pages
// and always passes the request on.
func Observer(rl *runlight.Runlight) echo.MiddlewareFunc {
	return echo.WrapMiddleware(rl.Observer)
}
