using System.Collections.Generic;

namespace Runlight.Tests.ConformanceRunner;

/// <summary>The messages a scenario's app mailer was handed, kept as http.json's mailed lists them, until the runner takes them.</summary>
public sealed class Mailbox
{
    private readonly object _lock = new();
    private List<JsObject> _mailed = [];

    /// <summary>Keeps one message: { to, from, fromName (only when it is not empty), subject, text }.</summary>
    public void Add(JsObject message)
    {
        lock (_lock)
        {
            _mailed.Add(message);
        }
    }

    /// <summary>The messages kept since the last call, in order.</summary>
    public List<JsObject> Take()
    {
        lock (_lock)
        {
            var taken = _mailed;
            _mailed = [];
            return taken;
        }
    }
}
