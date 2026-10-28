<?php

namespace App\Http\Middleware;

use App\Logging\RemoteLogger;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * Records every request and ships it (plus any buffered log entries) to the
 * logger service. The work happens in terminate(), which PHP-FPM runs after
 * the response has already been sent, so visitors don't wait on it.
 */
class LogRequests
{
    public function handle(Request $request, Closure $next): Response
    {
        return $next($request);
    }

    public function terminate(Request $request, Response $response): void
    {
        try {
            $ignore = config('services.remote_logger.ignore', []);

            if (! $ignore || ! $request->is(...$ignore)) {
                $start = $request->server('REQUEST_TIME_FLOAT') ?: (defined('LARAVEL_START') ? LARAVEL_START : microtime(true));

                $userId = null;
                try {
                    $userId = Auth::hasUser() ? Auth::id() : null;
                } catch (Throwable) {
                }

                RemoteLogger::request([
                    'ts' => (int) round($start * 1000),
                    'app' => config('services.remote_logger.app'),
                    'method' => $request->method(),
                    'path' => '/'.ltrim($request->getRequestUri(), '/'),
                    'route' => $request->route()?->uri(),
                    'status' => $response->getStatusCode(),
                    'duration_ms' => round((microtime(true) - $start) * 1000, 1),
                    'ip' => $request->ip(),
                    'user_id' => $userId,
                    'user_agent' => substr((string) $request->userAgent(), 0, 500),
                    'memory_mb' => round(memory_get_peak_usage(true) / 1048576, 1),
                ]);
            }
        } catch (Throwable $e) {
            error_log('[remote-logger] could not record request: '.$e->getMessage());
        }

        RemoteLogger::flush();
    }
}
