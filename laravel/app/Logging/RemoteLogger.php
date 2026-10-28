<?php

namespace App\Logging;

use Throwable;

/**
 * Buffers log entries and request records for the current request and sends
 * them to the logger service in a single HTTP call.
 *
 * Uses raw cURL rather than Laravel's Http client so a failure here can never
 * trigger more logging (and therefore recursion).
 */
class RemoteLogger
{
    protected static array $logs = [];

    protected static array $requests = [];

    protected static bool $shutdownRegistered = false;

    protected static bool $sending = false;

    public static function log(array $entry): void
    {
        static::$logs[] = $entry;
        static::afterPush();
    }

    public static function request(array $entry): void
    {
        static::$requests[] = $entry;
        static::afterPush();
    }

    protected static function afterPush(): void
    {
        if (! static::$shutdownRegistered) {
            static::$shutdownRegistered = true;
            register_shutdown_function([static::class, 'flush']);
        }

        // Queue workers and scheduled commands are long-lived, so send right away
        // instead of waiting for the process to end.
        if (app()->runningInConsole() || count(static::$logs) + count(static::$requests) >= 100) {
            static::flush();
        }
    }

    public static function flush(): void
    {
        if (static::$sending || (! static::$logs && ! static::$requests)) {
            return;
        }

        $payload = ['logs' => static::$logs, 'requests' => static::$requests];
        static::$logs = [];
        static::$requests = [];
        static::$sending = true;

        try {
            $url = config('services.remote_logger.url');
            $token = config('services.remote_logger.token');

            if (! $url || ! $token) {
                return;
            }

            $body = json_encode(
                $payload,
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE
            );

            $ch = curl_init(rtrim($url, '/').'/api/ingest');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'Authorization: Bearer '.$token,
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 2,
                CURLOPT_TIMEOUT => 3,
            ]);
            curl_exec($ch);

            $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            if (curl_errno($ch) || $status >= 300) {
                error_log('[remote-logger] send failed: '.(curl_error($ch) ?: "HTTP {$status}"));
            }
            curl_close($ch);
        } catch (Throwable $e) {
            error_log('[remote-logger] send failed: '.$e->getMessage());
        } finally {
            static::$sending = false;
        }
    }
}
