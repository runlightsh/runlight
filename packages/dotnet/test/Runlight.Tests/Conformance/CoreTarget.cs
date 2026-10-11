using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Runlight.Http;
using Runlight.Store;

namespace Runlight.Tests.ConformanceRunner;

/// <summary>The .NET core, through the public API the port conventions name.</summary>
public sealed class CoreTarget : ITarget
{
    private readonly global::Runlight.Runlight _rl;
    private readonly global::Runlight.Routes _routes;
    private readonly RequestHandler _links;

    public CoreTarget(PlayOptions options)
    {
        _rl = new global::Runlight.Runlight(Runlight(options));
        _routes = _rl.Routes(Routes(options.Routes));
        _links = _rl.LinkHandler();
    }

    /// <summary>The Runlight's options from the scenario's, with the store, clock, and fetcher the player made.</summary>
    public static RunlightOptions Runlight(PlayOptions options)
    {
        var o = options.Runlight;
        return new RunlightOptions
        {
            Store = (SqlStore)options.Store!,
            ManagedSites = o.Bool("managedSites"),
            Site = o.Obj("site") is JsObject site ? Site(site) : null,
            Sites = o.Arr("sites") is List<object?> sites ? sites.Cast<JsObject>().Select(Site).ToList() : null,
            Secret = o.Str("secret"),
            RateLimit = !o.Has("rateLimit") ? 120 : o.Get("rateLimit") is false or null ? null : o.Num("rateLimit"),
            Now = options.Now,
            Fetcher = options.Fetcher,
            MailServices = o.Arr("mailServices")?.Select(id => Js.String(id)).ToList(),
            Mail = o.Obj("appMailer") is JsObject app ? AppMailer(app, options.Mailed) : null,
        };
    }

    /// <summary>
    /// The scenario's app mailer: its send keeps each message in the mailbox, as http.json's mailed lists them,
    /// or fails with <c>fail</c> as its error's message.
    /// </summary>
    private static AppMailer AppMailer(JsObject app, Mailbox mailbox) => new()
    {
        From = app.Str("from")!,
        FromName = app.Str("fromName"),
        Via = app.Str("via")!,
        Send = (message, _) =>
        {
            if (app.Str("fail") is string fail)
            {
                throw new InvalidOperationException(fail);
            }
            var kept = new JsObject { ["to"] = message.Get("to"), ["from"] = message.Get("from") };
            if (Js.Truthy(message.Get("fromName")))
            {
                kept["fromName"] = message.Get("fromName");
            }
            kept["subject"] = message.Get("subject");
            kept["text"] = message.Get("text");
            mailbox.Add(kept);
            return Task.CompletedTask;
        },
    };

    /// <summary>The routes' options; the token is always set, null included, since unset reads RUNLIGHT_TOKEN.</summary>
    public static RoutesOptions Routes(JsObject o) => new()
    {
        Token = o.Str("token"),
        ObserveKey = o.Str("observeKey"),
        CronSecret = o.Str("cronSecret"),
        Accounts = o.Bool("accounts"),
        Origin = o.Str("origin"),
        Cms = o.Str("cms"),
    };

    private static SiteOptions Site(JsObject site) => new()
    {
        Id = site.Str("id"),
        Name = site.Str("name"),
        Hostnames = site.Arr("hostnames")?.Select(h => Js.String(h)).ToList(),
        Timezone = site.Str("timezone"),
    };

    public Task<Response> HandleAsync(Request request) => _routes.HandleAsync(request);

    public Task<Response> LinksAsync(Request request) => _links(request);

    public Task<Response?> LinkDomainAsync(Request request) => _rl.LinkDomainResponseAsync(request);

    /// <summary>TypeScript deletes visits past a shorter retention after answering; the .NET core queues that work for IdleAsync.</summary>
    public Task IdleAsync() => _rl.IdleAsync();
}
