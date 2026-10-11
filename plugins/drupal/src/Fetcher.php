<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Core\Site\Settings;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\TransferException;
use Psr\Log\LoggerInterface;
use Runlight\Http\BodyTooLong;
use Runlight\Http\Fetcher as RunlightFetcher;
use Runlight\Http\FetchError;
use Runlight\Http\Headers;
use Runlight\Http\Response;

/**
 * Runlight's outgoing requests, made through Drupal's HTTP client.
 *
 * So they follow this site's proxy settings and what other modules add to
 * it. Runlight sends them for what an owner sets up in its dashboard: email
 * through a mail service, imports, the assistant's AI provider, and a site's
 * icon.
 */
final class Fetcher implements RunlightFetcher {

  public function __construct(
    private readonly ClientInterface $httpClient,
    private readonly ?LoggerInterface $logger = NULL,
  ) {}

  /**
   * One request, as Runlight asks for it.
   *
   * @param string $url
   *   The address.
   * @param array<string, mixed> $init
   *   The request, with the keys fetch() takes.
   *
   * @return \Runlight\Http\Response
   *   The answer.
   *
   * @throws \Runlight\Http\FetchError
   *   When no answer came.
   */
  public function fetch(string $url, array $init = []): Response {
    $headers = $init['headers'] ?? [];
    $headers = $headers instanceof Headers ? $headers : new Headers($headers);
    $method = strtoupper((string) ($init['method'] ?? 'GET'));
    $max = isset($init['maxBytes']) ? (int) $init['maxBytes'] : NULL;
    $options = [
      'headers' => $headers->all(),
      'timeout' => ((int) ($init['timeoutMs'] ?? 30000)) / 1000,
      'allow_redirects' => ($init['redirect'] ?? 'follow') === 'manual' ? FALSE : [
        'max' => 20,
        'protocols' => ['http', 'https'],
      ],
      'http_errors' => FALSE,
      // Read as it arrives, so a body past the limit is never held whole.
      'stream' => TRUE,
    ];
    if (isset($init['body']) && !in_array($method, ['GET', 'HEAD'], TRUE)) {
      $options['body'] = (string) $init['body'];
    }
    // A pin connects to the address Runlight checked, with the name kept for
    // the certificate. Only cURL can, and only without a proxy, which would
    // look the name up again, so without either the request is refused.
    if (!empty($init['resolve'])) {
      if (!defined('CURLOPT_RESOLVE') || !function_exists('curl_exec')) {
        throw new FetchError('Runlight needs PHP’s curl extension to make this request safely.');
      }
      if (!empty(Settings::get('http_client_config', [])['proxy'] ?? NULL)) {
        throw new FetchError('Runlight cannot make this request safely through a proxy.');
      }
      $options['curl'] = [CURLOPT_RESOLVE => array_values($init['resolve'])];
      // Guzzle sends a streamed request with PHP's streams, which take no pin.
      $options['stream'] = FALSE;
    }
    try {
      $answer = $this->httpClient->request($method, $url, $options);
      $stream = $answer->getBody();
      $body = '';
      // One byte past the limit is enough to know the answer is too long.
      while (!$stream->eof() && ($max === NULL || strlen($body) <= $max)) {
        $body .= $stream->read(65536);
      }
      $stream->close();
    }
    catch (TransferException | \RuntimeException $e) {
      $message = $e->getMessage();
      throw new FetchError($message !== '' ? $message : 'fetch failed', (bool) preg_match('/timed out|error 28/i', $message), $e);
    }
    if ($max !== NULL && strlen($body) > $max) {
      if (empty($init['truncate'])) {
        throw new BodyTooLong("Body over $max bytes");
      }
      $body = substr($body, 0, $max);
    }
    $received = [];
    foreach ($answer->getHeaders() as $name => $values) {
      $received[strtolower((string) $name)] = array_map('strval', $values);
    }
    return new Response($body, $answer->getStatusCode(), $received);
  }

  /**
   * Saves the file at an address, for DB-IP's location data.
   *
   * @param string $url
   *   The address.
   * @param string $file
   *   Where to save it.
   *
   * @return bool
   *   Whether it arrived whole.
   */
  public function download(string $url, string $file): bool {
    try {
      $answer = $this->httpClient->request('GET', $url, ['timeout' => 300, 'sink' => $file, 'http_errors' => FALSE]);
      if ($answer->getStatusCode() === 200) {
        return TRUE;
      }
      $this->logger?->notice('Runlight could not download @url: it answered @code.', [
        '@url' => $url,
        '@code' => $answer->getStatusCode(),
      ]);
    }
    catch (\Throwable $e) {
      // What arrived goes below, and the release is tried again at the next
      // cron run.
      $this->logger?->notice('Runlight could not download @url: @message', [
        '@url' => $url,
        '@message' => $e->getMessage(),
      ]);
    }
    if (is_file($file)) {
      unlink($file);
    }
    return FALSE;
  }

}
