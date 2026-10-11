using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;

namespace Runlight.Tests;

/// <summary>
/// A small HTTP/1.1 server on 127.0.0.1 for the fetch tests, as the TypeScript tests use node:http: it keeps
/// every request it is sent, and answers each as <c>answer</c> says, closing the connection after.
/// </summary>
public sealed class LocalHttp : IAsyncDisposable
{
    /// <summary>A request as the server saw it, headers by lowercase name.</summary>
    public sealed record Seen(string Method, string Target, string Body, Dictionary<string, string> Headers)
    {
        public string Header(string name) => Headers.TryGetValue(name, out var value) ? value : "";
    }

    /// <summary>An answer: its status, headers, and body.</summary>
    public sealed record Answer(int Status, Dictionary<string, string>? Headers = null, string Body = "");

    private readonly TcpListener _listener;
    private readonly Func<Seen, Answer> _answer;
    private readonly List<Seen> _seen = [];
    private readonly Task _loop;

    public LocalHttp(Func<Seen, Answer> answer)
    {
        _answer = answer;
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _loop = Task.Run(async () =>
        {
            for (; ; )
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync();
                }
                catch (Exception)
                {
                    return;
                }
                _ = Task.Run(() => AnswerAsync(client));
            }
        });
    }

    public int Port { get; }

    /// <summary>http://127.0.0.1:{port}</summary>
    public string Base => "http://127.0.0.1:" + Port.ToString(CultureInfo.InvariantCulture);

    /// <summary>The requests so far, in order.</summary>
    public List<Seen> Requests
    {
        get
        {
            lock (_seen)
            {
                return [.. _seen];
            }
        }
    }

    /// <summary>Forgets the requests so far.</summary>
    public void Clear()
    {
        lock (_seen)
        {
            _seen.Clear();
        }
    }

    private async Task AnswerAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                var stream = client.GetStream();
                var head = new MemoryStream();
                var one = new byte[1];
                while (!EndsWithBlankLine(head))
                {
                    if (await stream.ReadAsync(one) == 0)
                    {
                        return;
                    }
                    head.WriteByte(one[0]);
                }
                string[] lines = Encoding.Latin1.GetString(head.ToArray()).Split("\r\n");
                string[] first = lines[0].Split(' ');
                var headers = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (string line in lines[1..])
                {
                    int colon = line.IndexOf(':', StringComparison.Ordinal);
                    if (colon > 0)
                    {
                        headers[line[..colon].Trim().ToLowerInvariant()] = line[(colon + 1)..].Trim();
                    }
                }
                int length = headers.TryGetValue("content-length", out var given) ? int.Parse(given, CultureInfo.InvariantCulture) : 0;
                var body = new byte[length];
                int read = 0;
                while (read < length)
                {
                    int n = await stream.ReadAsync(body.AsMemory(read));
                    if (n == 0)
                    {
                        break;
                    }
                    read += n;
                }
                var seen = new Seen(first[0], first.Length > 1 ? first[1] : "", Encoding.UTF8.GetString(body, 0, read), headers);
                lock (_seen)
                {
                    _seen.Add(seen);
                }
                var answer = _answer(seen);
                byte[] content = Encoding.UTF8.GetBytes(answer.Body);
                var text = new StringBuilder();
                text.Append(CultureInfo.InvariantCulture, $"HTTP/1.1 {answer.Status} Answer\r\n");
                foreach (var (name, value) in answer.Headers ?? [])
                {
                    text.Append(name).Append(": ").Append(value).Append("\r\n");
                }
                text.Append(CultureInfo.InvariantCulture, $"content-length: {content.Length}\r\nconnection: close\r\n\r\n");
                await stream.WriteAsync(Encoding.Latin1.GetBytes(text.ToString()));
                await stream.WriteAsync(content);
            }
            catch (IOException)
            {
                // The client went away.
            }
        }
    }

    private static bool EndsWithBlankLine(MemoryStream head)
    {
        if (head.Length < 4)
        {
            return false;
        }
        var b = head.GetBuffer();
        long n = head.Length;
        return b[n - 4] == '\r' && b[n - 3] == '\n' && b[n - 2] == '\r' && b[n - 1] == '\n';
    }

    public async ValueTask DisposeAsync()
    {
        _listener.Stop();
        await _loop;
    }
}
