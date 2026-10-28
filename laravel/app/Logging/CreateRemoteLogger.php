<?php

namespace App\Logging;

use Monolog\Logger;

/**
 * Factory for the "remote" log channel in config/logging.php.
 */
class CreateRemoteLogger
{
    public function __invoke(array $config): Logger
    {
        return new Logger('remote', [
            new RemoteLogHandler($config['level'] ?? 'warning'),
        ]);
    }
}
