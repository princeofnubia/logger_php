<?php

namespace App\Logging;

use Illuminate\Contracts\Support\Arrayable;
use Illuminate\Support\Facades\Auth;
use JsonSerializable;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\LogRecord;
use Throwable;

class RemoteLogHandler extends AbstractProcessingHandler
{
    protected static bool $writing = false;

    protected function write(LogRecord $record): void
    {
        // Anything below (e.g. resolving the user) could itself log; don't loop.
        if (static::$writing) {
            return;
        }
        static::$writing = true;

        try {
            $context = $record->context;
            $exception = null;

            if (($context['exception'] ?? null) instanceof Throwable) {
                $e = $context['exception'];
                $exception = [
                    'class' => get_class($e),
                    'message' => $e->getMessage(),
                    'file' => $e->getFile(),
                    'line' => $e->getLine(),
                    'trace' => $e->getTraceAsString(),
                ];
                unset($context['exception']);
            }

            RemoteLogger::log(array_merge([
                'ts' => $record->datetime->format('Y-m-d\TH:i:s.uP'),
                'app' => config('services.remote_logger.app'),
                'level' => $record->level->toPsrLogLevel(),
                'message' => $record->message,
                'channel' => $record->channel,
                'context' => $this->normalize($context),
                'exception' => $exception,
            ], $this->requestInfo()));
        } catch (Throwable $e) {
            error_log('[remote-logger] could not record log entry: '.$e->getMessage());
        } finally {
            static::$writing = false;
        }
    }

    protected function requestInfo(): array
    {
        if (app()->runningInConsole() || ! app()->bound('request')) {
            return [];
        }

        $request = request();
        $userId = null;
        try {
            // hasUser() avoids a database lookup, which may be what just failed.
            $userId = Auth::hasUser() ? Auth::id() : null;
        } catch (Throwable) {
        }

        return [
            'url' => $request->fullUrl(),
            'method' => $request->method(),
            'ip' => $request->ip(),
            'user_id' => $userId,
        ];
    }

    protected function normalize(mixed $value, int $depth = 0): mixed
    {
        if ($depth > 5) {
            return '[depth limit]';
        }
        if (is_array($value)) {
            return array_map(fn ($v) => $this->normalize($v, $depth + 1), array_slice($value, 0, 100, true));
        }
        if ($value instanceof Throwable) {
            return get_class($value).': '.$value->getMessage();
        }
        if ($value instanceof Arrayable) {
            return $this->normalize($value->toArray(), $depth + 1);
        }
        if ($value instanceof JsonSerializable) {
            return $this->normalize($value->jsonSerialize(), $depth + 1);
        }
        if ($value instanceof \DateTimeInterface) {
            return $value->format(DATE_ATOM);
        }
        if (is_object($value)) {
            return method_exists($value, '__toString') ? (string) $value : '['.get_class($value).']';
        }
        if (is_resource($value)) {
            return '[resource]';
        }

        return $value;
    }
}
