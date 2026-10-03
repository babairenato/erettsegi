<?php
/**
 * Gyakorlo Feladatok - Biztonsagos PHP API Controller
 * Kezeli a hitelesitest, rate-limitinget, adatszivargas elleni maszkolast es a statuszokat.
 */

// Hibauzenetek elrejtese a latogatok elol
ini_set('display_errors', '0');
error_reporting(0);

// 1. Biztonsagi fejlecek
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('X-XSS-Protection: 1; mode=block');
header('Referrer-Policy: strict-origin-when-cross-origin');

// 2. Biztonsagos Session beallitasok
ini_set('session.cookie_httponly', 1);
ini_set('session.cookie_samesite', 'Strict');
ini_set('session.use_only_cookies', 1);

session_start();

// Szerver eleresi utak
define('DATA_DIR', __DIR__ . '/data');
define('TASKS_FILE', DATA_DIR . '/tasks_data.json');
define('STATUS_FILE', DATA_DIR . '/status.json');
define('LESSONS_FILE', DATA_DIR . '/task_lessons.json');
define('RATELIMIT_FILE', DATA_DIR . '/rate_limit.json');

// Kriptografiai so es felhasznaloi HMAC hashek (nincs nyers jelszo a kodban!)
define('AUTH_SALT', 'erettsegi_secure_salt_8f7b2c9a1d4e');

$USERS = [
    'admin31415' => [
        'role' => 'admin',
        'hmac' => '2b57a0d59ddfb461135147b81d4c6e9b16f26d1247b3a2475bea6b2937818a7e'
    ],
    'diak31415' => [
        'role' => 'student',
        'hmac' => 'a2cb8925384fe3d08ad69df6febf2414f8f2dda237783c7668434423206cec66'
    ]
];

// ----------------------------------------------------------------------
// Rate Limiter (Brute force elleni vedelem)
// ----------------------------------------------------------------------
function getClientIp() {
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
}

function checkRateLimit($ip) {
    $maxAttempts = 5;
    $lockoutSeconds = 300; // 5 perc
    $now = time();

    if (!file_exists(RATELIMIT_FILE)) {
        return ['allowed' => true];
    }

    $fp = @fopen(RATELIMIT_FILE, 'r');
    if (!$fp) return ['allowed' => true];

    flock($fp, LOCK_SH);
    $content = stream_get_contents($fp);
    flock($fp, LOCK_UN);
    fclose($fp);

    $limits = json_decode($content, true);
    if (!is_array($limits) || !isset($limits[$ip])) {
        return ['allowed' => true];
    }

    $record = $limits[$ip];
    if (isset($record['lockedUntil']) && $record['lockedUntil'] > $now) {
        return [
            'allowed' => false,
            'remainingSec' => ($record['lockedUntil'] - $now)
        ];
    }

    return ['allowed' => true];
}

function recordFailedLogin($ip) {
    $maxAttempts = 5;
    $lockoutSeconds = 300;
    $now = time();

    $limits = [];
    $fp = @fopen(RATELIMIT_FILE, 'c+');
    if (!$fp) return;

    if (flock($fp, LOCK_EX)) {
        $content = stream_get_contents($fp);
        $limits = json_decode($content, true);
        if (!is_array($limits)) $limits = [];

        // Expired bejegyzesek takaritasa
        foreach ($limits as $k => $v) {
            if (isset($v['lockedUntil']) && $v['lockedUntil'] < $now && ($now - $v['lockedUntil']) > 3600) {
                unset($limits[$k]);
            }
        }

        $attempts = isset($limits[$ip]['count']) ? $limits[$ip]['count'] + 1 : 1;
        $limits[$ip] = [
            'count' => $attempts,
            'lastAttempt' => $now
        ];

        if ($attempts >= $maxAttempts) {
            $limits[$ip]['lockedUntil'] = $now + $lockoutSeconds;
        }

        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($limits));
        fflush($fp);
        flock($fp, LOCK_UN);
    }
    fclose($fp);
}

function clearRateLimit($ip) {
    if (!file_exists(RATELIMIT_FILE)) return;
    $fp = @fopen(RATELIMIT_FILE, 'c+');
    if (!$fp) return;

    if (flock($fp, LOCK_EX)) {
        $content = stream_get_contents($fp);
        $limits = json_decode($content, true);
        if (is_array($limits) && isset($limits[$ip])) {
            unset($limits[$ip]);
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($limits));
            fflush($fp);
        }
        flock($fp, LOCK_UN);
    }
    fclose($fp);
}

// ----------------------------------------------------------------------
// Munkamenet es bemenet segedfuggvenyek
// ----------------------------------------------------------------------
function isSessionValid() {
    return isset($_SESSION['is_admin']) && $_SESSION['is_admin'] === true;
}
function isStudentSessionValid() {
    return isset($_SESSION['is_student']) && $_SESSION['is_student'] === true;
}
function isAnySessionValid() {
    return isSessionValid() || isStudentSessionValid();
}

function isValidTaskId($id) {
    if (!is_string($id)) return false;
    $dangerous = ['__proto__', 'constructor', 'prototype'];
    if (in_array($id, $dangerous, true)) return false;
    return preg_match('/^[A-Za-z0-9_-]{1,32}$/', $id) === 1;
}

function getJsonInput() {
    $input = file_get_contents('php://input');
    return json_decode($input, true);
}

$action = isset($_GET['action']) ? $_GET['action'] : '';

// ----------------------------------------------------------------------
// API Utvonalak
// ----------------------------------------------------------------------
switch ($action) {

    // ----------------------------------------------------------------------
    // Bejelentkezes
    // ----------------------------------------------------------------------
    case 'login':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'Method Not Allowed']);
            exit;
        }

        $ip = getClientIp();
        $rate = checkRateLimit($ip);
        if (!$rate['allowed']) {
            http_response_code(429);
            echo json_encode([
                'success' => false,
                'message' => 'Túl sok sikertelen kísérlet! Kérjük próbáld újra ' . $rate['remainingSec'] . ' másodperc múlva.'
            ]);
            exit;
        }

        $body = getJsonInput();
        $username = isset($body['username']) ? trim($body['username']) : '';
        $password = isset($body['password']) ? (string)$body['password'] : '';

        $userMatch = null;
        if (isset($USERS[$username])) {
            $expectedHmac = $USERS[$username]['hmac'];
            $calculatedHmac = hash_hmac('sha256', $password, AUTH_SALT);
            if (hash_equals($expectedHmac, $calculatedHmac)) {
                $userMatch = $USERS[$username];
            }
        }

        if ($userMatch !== null) {
            clearRateLimit($ip);

            // Session Fixation elharitasa: uj session ID generalasa
            session_regenerate_id(true);

            $_SESSION['is_admin'] = ($userMatch['role'] === 'admin');
            $_SESSION['is_student'] = ($userMatch['role'] === 'student');
            $_SESSION['username'] = $username;

            echo json_encode(['success' => true]);
        } else {
            recordFailedLogin($ip);
            http_response_code(401);
            echo json_encode(['success' => false, 'message' => 'Helytelen felhasználónév vagy jelszó!']);
        }
        break;

    // ----------------------------------------------------------------------
    // Kijelentkezes
    // ----------------------------------------------------------------------
    case 'logout':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'Method Not Allowed']);
            exit;
        }

        $_SESSION = [];
        if (ini_get("session.use_cookies")) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000,
                $params["path"], $params["domain"],
                $params["secure"], $params["httponly"]
            );
        }
        session_destroy();
        echo json_encode(['success' => true]);
        break;

    // ----------------------------------------------------------------------
    // Feladatok Lekerdezese (Adatmaszkolassal)
    // ----------------------------------------------------------------------
    case 'tasks':
        if (!file_exists(TASKS_FILE)) {
            http_response_code(500);
            echo json_encode(['error' => 'Adatbázis hiba']);
            exit;
        }

        $tasksData = json_decode(file_get_contents(TASKS_FILE), true);
        if (!is_array($tasksData)) {
            http_response_code(500);
            echo json_encode(['error' => 'Adatformátum hiba']);
            exit;
        }

        $loggedIn = isAnySessionValid();

        if ($loggedIn) {
            $unlockedTasks = array_map(function($task) {
                $task['isLocked'] = false;
                return $task;
            }, $tasksData);

            $role = isSessionValid() ? 'admin' : 'student';
            echo json_encode(['isLoggedIn' => true, 'role' => $role, 'tasks' => $unlockedTasks]);
            exit;
        }

        // Vendeg eseten biztonsagi adatmaszkolas kategoria-index alapjan
        $categoryCounts = [];
        $maskedTasks = [];

        foreach ($tasksData as $task) {
            $cat = $task['category'];
            if (!isset($categoryCounts[$cat])) {
                $categoryCounts[$cat] = 0;
            }

            $index = $categoryCounts[$cat];
            $categoryCounts[$cat]++;

            if ($index >= 3) {
                $maskedTasks[] = [
                    'id' => $task['id'],
                    'category' => $task['category'],
                    'categoryName' => $task['categoryName'],
                    'title' => $task['title'],
                    'isLocked' => true
                ];
            } else {
                $task['isLocked'] = false;
                $maskedTasks[] = $task;
            }
        }

        echo json_encode(['isLoggedIn' => false, 'tasks' => $maskedTasks]);
        break;

    // ----------------------------------------------------------------------
    // Statuszkovetes (Kesz / Atnezendo)
    // ----------------------------------------------------------------------
    case 'status':
        if (!isAnySessionValid()) {
            http_response_code(401);
            echo json_encode(['error' => 'Unauthorized']);
            exit;
        }

        $username = isset($_SESSION['username']) ? $_SESSION['username'] : 'unknown';

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $allStatuses = [];
            if (file_exists(STATUS_FILE)) {
                $allStatuses = json_decode(file_get_contents(STATUS_FILE), true);
                if (!is_array($allStatuses)) $allStatuses = [];

                $keys = array_keys($allStatuses);
                $isOldFormat = false;
                foreach ($keys as $k) {
                    if (strpos($k, 'S') === 0) {
                        $isOldFormat = true;
                        break;
                    }
                }
                if ($isOldFormat) {
                    $allStatuses = ['admin31415' => $allStatuses];
                }
            }

            $userStatuses = isset($allStatuses[$username]) ? $allStatuses[$username] : new stdClass();
            echo json_encode($userStatuses);
            exit;
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $body = getJsonInput();
            $taskId = isset($body['taskId']) ? trim($body['taskId']) : '';
            $status = isset($body['status']) ? trim($body['status']) : '';

            if (!isValidTaskId($taskId)) {
                http_response_code(400);
                echo json_encode(['error' => 'Érvénytelen feladat azonosító']);
                exit;
            }

            $allowedStatuses = ['kesz', 'atnezendo', 'default'];
            if (!in_array($status, $allowedStatuses, true)) {
                http_response_code(400);
                echo json_encode(['error' => 'Érvénytelen státusz']);
                exit;
            }

            $allStatuses = [];
            if (file_exists(STATUS_FILE)) {
                $allStatuses = json_decode(file_get_contents(STATUS_FILE), true);
                if (!is_array($allStatuses)) $allStatuses = [];

                $keys = array_keys($allStatuses);
                $isOldFormat = false;
                foreach ($keys as $k) {
                    if (strpos($k, 'S') === 0) {
                        $isOldFormat = true;
                        break;
                    }
                }
                if ($isOldFormat) {
                    $allStatuses = ['admin31415' => $allStatuses];
                }
            }

            if (!isset($allStatuses[$username])) {
                $allStatuses[$username] = [];
            }

            if ($status === 'default') {
                unset($allStatuses[$username][$taskId]);
            } else {
                $allStatuses[$username][$taskId] = $status;
            }

            if (file_put_contents(STATUS_FILE, json_encode($allStatuses, JSON_PRETTY_PRINT)) !== false) {
                echo json_encode(['success' => true]);
            } else {
                http_response_code(500);
                echo json_encode(['error' => 'Mentési hiba']);
            }
            exit;
        }
        break;

    // ----------------------------------------------------------------------
    // Orak Hozzaadasa / Kezelese (Kizarolag Admin)
    // ----------------------------------------------------------------------
    case 'lessons':
        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            if (file_exists(LESSONS_FILE)) {
                echo file_get_contents(LESSONS_FILE);
            } else {
                echo json_encode(new stdClass());
            }
            exit;
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            if (!isSessionValid()) {
                http_response_code(401);
                echo json_encode(['error' => 'Unauthorized']);
                exit;
            }

            $body = getJsonInput();
            $taskId = isset($body['taskId']) ? trim($body['taskId']) : '';
            $lesson = isset($body['lesson']) ? $body['lesson'] : null;

            if (!isValidTaskId($taskId)) {
                http_response_code(400);
                echo json_encode(['error' => 'Érvénytelen feladat azonosító']);
                exit;
            }

            $lessonsData = [];
            if (file_exists(LESSONS_FILE)) {
                $lessonsData = json_decode(file_get_contents(LESSONS_FILE), true);
                if (!is_array($lessonsData)) $lessonsData = [];
            }

            if ($lesson === null || $lesson === '') {
                unset($lessonsData[$taskId]);
            } else {
                $lessonNum = intval($lesson);
                if ($lessonNum < 1 || $lessonNum > 20) {
                    http_response_code(400);
                    echo json_encode(['error' => 'Érvénytelen óraszám (1-20)']);
                    exit;
                }
                $lessonsData[$taskId] = $lessonNum;
            }

            if (file_put_contents(LESSONS_FILE, json_encode($lessonsData, JSON_PRETTY_PRINT)) !== false) {
                echo json_encode(['success' => true]);
            } else {
                http_response_code(500);
                echo json_encode(['error' => 'Mentési hiba']);
            }
            exit;
        }
        break;

    default:
        http_response_code(404);
        echo json_encode(['error' => 'Nem található']);
        break;
}
