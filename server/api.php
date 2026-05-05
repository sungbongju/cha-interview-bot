<?php
/**
 * cha-interview-bot - 면담봇 API
 * 베이스: finmarket-api/api.php 패턴
 * DB: cha_interview_db
 */
date_default_timezone_set('Asia/Seoul');
error_reporting(E_ALL);
ini_set('display_errors', 0);

header('Content-Type: application/json; charset=utf-8');
$allowed_origins = array(
    'https://cha-interview-bot.vercel.app',
    'https://aiforalab.com',
    'http://localhost:5173',
    'http://localhost:3000',
);
$origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
if (in_array($origin, $allowed_origins)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ─── DB / JWT (환경변수에서 로드 — Apache .htaccess SetEnv) ───
$db_host    = 'localhost';
$db_name    = 'cha_interview_db';
$db_user    = getenv('CHA_DB_USER')    ?: '';
$db_pass    = getenv('CHA_DB_PASS')    ?: '';
$JWT_SECRET = getenv('CHA_JWT_SECRET') ?: '';

if (empty($db_user) || empty($db_pass) || empty($JWT_SECRET)) {
    error_log('[interview-api] Missing env: CHA_DB_USER / CHA_DB_PASS / CHA_JWT_SECRET');
    echo json_encode(array('success' => false, 'error' => 'Server configuration error'));
    exit;
}

try {
    $pdo = new PDO(
        "mysql:host=$db_host;dbname=$db_name;charset=utf8mb4",
        $db_user, $db_pass,
        array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC)
    );
} catch (PDOException $e) {
    echo json_encode(array('success' => false, 'error' => 'DB connection failed'));
    exit;
}

// ─── Routing ───
$action = '';
$input = array();
if (isset($_GET['action'])) $action = $_GET['action'];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    $input = json_decode($raw, true);
    if (!$input) $input = array();
    if (!$action && isset($input['action'])) $action = $input['action'];
} else {
    $input = $_GET;
}

switch ($action) {
    case 'health':
        echo json_encode(array('status' => 'ok', 'service' => 'cha-interview-bot API'));
        break;
    case 'kakao_login':
        handleKakaoLogin($pdo, $input);
        break;
    case 'email_signup':
        handleEmailSignup($pdo, $input);
        break;
    case 'email_login':
        handleEmailLogin($pdo, $input);
        break;
    case 'verify':
        handleVerify($pdo, $input);
        break;
    case 'save_chat':
        handleSaveChat($pdo, $input);
        break;
    case 'list_chats':
        handleListChats($pdo, $input);
        break;
    case 'save_survey':
        handleSaveSurvey($pdo, $input);
        break;
    case 'survey_summary':
        handleSurveySummary($pdo, $input);
        break;
    case 'usage_summary':
        handleUsageSummary($pdo, $input);
        break;
    default:
        echo json_encode(array('success' => false, 'error' => 'Unknown action: ' . $action));
}

// ─── Password Hash (PHP 5.4 호환 — crypt() bcrypt 직접 사용) ───
function pwHash($password) {
    // bcrypt $2y$10$ 형식 22자 salt
    $bytes = openssl_random_pseudo_bytes(16);
    $b64 = strtr(rtrim(base64_encode($bytes), '='), '+', '.');
    $salt = '$2y$10$' . substr($b64, 0, 22);
    return crypt($password, $salt);
}
function pwVerify($password, $hash) {
    if (!$hash || strlen($hash) < 7) return false;
    $check = crypt($password, $hash);
    if (function_exists('hash_equals')) return hash_equals($hash, $check);
    return $hash === $check;
}

// ─── JWT ───
function createJWT($userId, $secret) {
    $header = base64_encode(json_encode(array('typ' => 'JWT', 'alg' => 'HS256')));
    $payload = base64_encode(json_encode(array('user_id' => $userId, 'exp' => time() + 86400 * 7)));
    $sig = base64_encode(hash_hmac('sha256', "$header.$payload", $secret, true));
    return "$header.$payload.$sig";
}

function verifyJWT($token, $secret) {
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    $sig = base64_encode(hash_hmac('sha256', $parts[0] . '.' . $parts[1], $secret, true));
    if ($sig !== $parts[2]) return null;
    $payload = json_decode(base64_decode($parts[1]), true);
    if (!$payload || $payload['exp'] < time()) return null;
    return $payload;
}

function getUserFromToken($pdo, $input) {
    global $JWT_SECRET;
    $token = '';
    if (isset($input['token'])) $token = $input['token'];
    if (!$token && isset($_GET['token'])) $token = $_GET['token'];
    if (!$token && isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'];
        if (preg_match('/Bearer\s+(.+)/', $auth, $m)) $token = $m[1];
    }
    if (!$token) return null;
    $payload = verifyJWT($token, $JWT_SECRET);
    if (!$payload) return null;
    return $payload;
}

// ─── Kakao Login ───
function handleKakaoLogin($pdo, $input) {
    global $JWT_SECRET;
    $kakao_id = isset($input['kakao_id']) ? trim($input['kakao_id']) : '';
    $nickname = isset($input['nickname']) ? trim($input['nickname']) : '';
    $email    = isset($input['email'])    ? trim($input['email'])    : null;

    if (empty($kakao_id) || empty($nickname)) {
        echo json_encode(array('success' => false, 'error' => 'kakao_id and nickname required'));
        return;
    }

    $stmt = $pdo->prepare('SELECT * FROM users WHERE kakao_id = ?');
    $stmt->execute(array($kakao_id));
    $user = $stmt->fetch();

    if ($user) {
        $pdo->prepare('UPDATE users SET visit_count = visit_count + 1, last_login = NOW(), name = ?, email = COALESCE(?, email) WHERE kakao_id = ?')
            ->execute(array($nickname, $email, $kakao_id));
        $stmt = $pdo->prepare('SELECT * FROM users WHERE kakao_id = ?');
        $stmt->execute(array($kakao_id));
        $user = $stmt->fetch();
    } else {
        $stmt = $pdo->prepare('INSERT INTO users (kakao_id, name, email, visit_count, last_login) VALUES (?, ?, ?, 1, NOW())');
        $stmt->execute(array($kakao_id, $nickname, $email));
        $user = array(
            'id' => $pdo->lastInsertId(),
            'kakao_id' => $kakao_id,
            'name' => $nickname,
            'email' => $email,
            'visit_count' => 1
        );
    }

    $token = createJWT($user['id'], $JWT_SECRET);
    echo json_encode(array(
        'success' => true,
        'token' => $token,
        'user' => array(
            'id' => $user['id'],
            'name' => $user['name'],
            'email' => $user['email'],
            'visit_count' => $user['visit_count']
        )
    ));
}

// ─── Email Signup ───
function handleEmailSignup($pdo, $input) {
    global $JWT_SECRET;
    $email    = isset($input['email'])    ? trim($input['email'])    : '';
    $password = isset($input['password']) ? $input['password']        : '';
    $name     = isset($input['name'])     ? trim($input['name'])     : '';

    if (!$email || !$password || !$name) {
        echo json_encode(array('success' => false, 'error' => 'email, password, name required'));
        return;
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        echo json_encode(array('success' => false, 'error' => 'invalid email'));
        return;
    }
    if (strlen($password) < 6) {
        echo json_encode(array('success' => false, 'error' => 'password too short (min 6)'));
        return;
    }

    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $stmt->execute(array($email));
    if ($stmt->fetch()) {
        echo json_encode(array('success' => false, 'error' => 'email already registered'));
        return;
    }

    $hash = pwHash($password);
    $stmt = $pdo->prepare('INSERT INTO users (email, password_hash, name, visit_count, last_login) VALUES (?, ?, ?, 1, NOW())');
    $stmt->execute(array($email, $hash, $name));
    $userId = $pdo->lastInsertId();

    $token = createJWT($userId, $JWT_SECRET);
    echo json_encode(array(
        'success' => true,
        'token' => $token,
        'user' => array('id' => $userId, 'name' => $name, 'email' => $email, 'visit_count' => 1)
    ));
}

// ─── Email Login ───
function handleEmailLogin($pdo, $input) {
    global $JWT_SECRET;
    $email    = isset($input['email'])    ? trim($input['email'])    : '';
    $password = isset($input['password']) ? $input['password']        : '';

    if (!$email || !$password) {
        echo json_encode(array('success' => false, 'error' => 'email and password required'));
        return;
    }

    $stmt = $pdo->prepare('SELECT * FROM users WHERE email = ?');
    $stmt->execute(array($email));
    $user = $stmt->fetch();
    if (!$user || !$user['password_hash'] || !pwVerify($password, $user['password_hash'])) {
        echo json_encode(array('success' => false, 'error' => 'invalid email or password'));
        return;
    }

    $pdo->prepare('UPDATE users SET visit_count = visit_count + 1, last_login = NOW() WHERE id = ?')
        ->execute(array($user['id']));

    $token = createJWT($user['id'], $JWT_SECRET);
    echo json_encode(array(
        'success' => true,
        'token' => $token,
        'user' => array('id' => $user['id'], 'name' => $user['name'], 'email' => $user['email'], 'visit_count' => $user['visit_count'] + 1)
    ));
}

// ─── Verify Token ───
function handleVerify($pdo, $input) {
    $payload = getUserFromToken($pdo, $input);
    if (!$payload) {
        echo json_encode(array('success' => false, 'error' => 'invalid token'));
        return;
    }
    $stmt = $pdo->prepare('SELECT id, name, email, kakao_id, visit_count FROM users WHERE id = ?');
    $stmt->execute(array($payload['user_id']));
    $user = $stmt->fetch();
    echo json_encode(array('success' => true, 'user' => $user));
}

// ─── Save Chat ───
function handleSaveChat($pdo, $input) {
    $session_id = isset($input['session_id']) ? trim($input['session_id']) : '';
    $role       = isset($input['role'])       ? $input['role']             : '';
    $message    = isset($input['message'])    ? trim($input['message'])    : '';
    $rag_hits   = isset($input['rag_hits'])   ? $input['rag_hits']         : null;

    if (!$session_id || !in_array($role, array('user','assistant')) || !$message) {
        echo json_encode(array('success' => false, 'error' => 'session_id, role(user|assistant), message required'));
        return;
    }
    if (is_array($rag_hits)) $rag_hits = json_encode($rag_hits, JSON_UNESCAPED_UNICODE);

    $payload = getUserFromToken($pdo, $input);
    $user_id = $payload ? $payload['user_id'] : null;

    $stmt = $pdo->prepare('INSERT INTO chat_logs (user_id, session_id, role, message, rag_hits) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute(array($user_id, $session_id, $role, $message, $rag_hits));
    echo json_encode(array('success' => true, 'id' => $pdo->lastInsertId()));
}

// ─── List Chats (사용자 본인 + admin은 다 볼 수 있게 — 일단 본인만) ───
function handleListChats($pdo, $input) {
    $payload = getUserFromToken($pdo, $input);
    if (!$payload) {
        echo json_encode(array('success' => false, 'error' => 'login required'));
        return;
    }
    $limit = isset($input['limit']) ? max(1, min(500, (int)$input['limit'])) : 100;
    $stmt = $pdo->prepare('SELECT id, session_id, role, message, created_at FROM chat_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ' . $limit);
    $stmt->execute(array($payload['user_id']));
    echo json_encode(array('success' => true, 'rows' => $stmt->fetchAll()));
}

// ─── Save Survey (신뢰설계 컴포넌트 평가 v1) ───
function handleSaveSurvey($pdo, $input) {
    $payload = getUserFromToken($pdo, $input);
    $user_id = $payload ? $payload['user_id'] : null;

    $session_id     = isset($input['session_id'])     ? trim($input['session_id'])     : null;
    $survey_version = isset($input['survey_version']) ? trim($input['survey_version']) : 'v1';

    // 인구통계
    $allowed_grade  = array('1','2','3','4','etc');
    $allowed_gender = array('female','male','no_answer');
    $allowed_majors = array('none','세포유전자재생의학','바이오식의약학','시스템생명과학','스포츠의학','심리학','미술치료','디지털보건의료','경영학','미디어커뮤니케이션학','AI의료데이터학','소프트웨어융합');

    $grade  = isset($input['grade'])  && in_array($input['grade'], $allowed_grade)  ? $input['grade']  : null;
    $gender = isset($input['gender']) && in_array($input['gender'], $allowed_gender) ? $input['gender'] : null;
    $mbti   = isset($input['mbti'])   ? strtoupper(substr(trim($input['mbti']), 0, 4)) : null;
    if ($mbti !== null && !preg_match('/^[EI][SN][TF][JP]$/', $mbti)) $mbti = null;
    $major1 = isset($input['major1']) && in_array($input['major1'], $allowed_majors) ? $input['major1'] : null;
    $major2 = isset($input['major2']) && in_array($input['major2'], $allowed_majors) ? $input['major2'] : null;

    // Yes/No 정규화: true/1/'yes' → 1, false/0/'no' → 0, 미응답/null → null
    $toBool = function($v) {
        if ($v === null || $v === '' || $v === 'na' || $v === 'NA') return null;
        if ($v === true || $v === 1 || $v === '1' || $v === 'yes' || $v === 'Y' || $v === 'y') return 1;
        if ($v === false || $v === 0 || $v === '0' || $v === 'no'  || $v === 'N' || $v === 'n') return 0;
        return null;
    };

    $q_keys = array(
        'q06_digital_twin','q07_institution_id','q08_ai_disclosure',
        'q09_rag_grounding','q10_limit_admit','q11_warm_tone','q12_format_consistency',
        'q13_latency_pacing','q14_echo_guard','q15_esc_interrupt','q16_avatar_embodiment','q17_mode_switch',
        'q18_consent_ui','q19_guest_browse','q20_korean_ordinal','q21_visit_tracking','q22_tts_normalize','q23_kakao_redirect',
        'q24_overall_trust'
    );
    $q_vals = array();
    foreach ($q_keys as $k) {
        $q_vals[$k] = $toBool(isset($input[$k]) ? $input[$k] : null);
    }

    // 4-layer 합산 (NULL은 0으로 취급하지 않고 합에서 제외 → COALESCE 처리)
    $sum = function($keys, $vals) {
        $s = 0;
        foreach ($keys as $k) if ($vals[$k] === 1) $s++;
        return $s;
    };
    $layer1_score = $sum(array('q06_digital_twin','q07_institution_id','q08_ai_disclosure'), $q_vals);
    $layer2_score = $sum(array('q09_rag_grounding','q10_limit_admit','q11_warm_tone','q12_format_consistency'), $q_vals);
    $layer3_score = $sum(array('q13_latency_pacing','q14_echo_guard','q15_esc_interrupt','q16_avatar_embodiment','q17_mode_switch'), $q_vals);
    $layer4_score = $sum(array('q18_consent_ui','q19_guest_browse','q20_korean_ordinal','q21_visit_tracking','q22_tts_normalize','q23_kakao_redirect'), $q_vals);
    $total_yes_count = $layer1_score + $layer2_score + $layer3_score + $layer4_score;

    // 자유응답
    $free_positive = isset($input['free_positive']) ? mb_substr(trim($input['free_positive']), 0, 2000) : null;
    $free_negative = isset($input['free_negative']) ? mb_substr(trim($input['free_negative']), 0, 2000) : null;

    // 메타
    $duration_seconds = isset($input['duration_seconds']) ? (int)$input['duration_seconds'] : null;
    $flag_too_fast = ($duration_seconds !== null && $duration_seconds < 60) ? 1 : 0;
    $user_agent = isset($_SERVER['HTTP_USER_AGENT']) ? mb_substr($_SERVER['HTTP_USER_AGENT'], 0, 255) : null;

    $cols = array_merge(
        array('user_id','session_id','survey_version','grade','gender','mbti','major1','major2'),
        $q_keys,
        array('layer1_score','layer2_score','layer3_score','layer4_score','total_yes_count',
              'free_positive','free_negative','user_agent','duration_seconds','flag_too_fast')
    );
    $placeholders = implode(',', array_fill(0, count($cols), '?'));
    $params = array(
        $user_id, $session_id, $survey_version, $grade, $gender, $mbti, $major1, $major2
    );
    foreach ($q_keys as $k) $params[] = $q_vals[$k];
    $params = array_merge($params, array(
        $layer1_score, $layer2_score, $layer3_score, $layer4_score, $total_yes_count,
        $free_positive, $free_negative, $user_agent, $duration_seconds, $flag_too_fast
    ));

    $sql = 'INSERT INTO survey_responses (' . implode(',', $cols) . ') VALUES (' . $placeholders . ')';

    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        echo json_encode(array(
            'success' => true,
            'id' => $pdo->lastInsertId(),
            'layer_scores' => array(
                'L1' => $layer1_score, 'L2' => $layer2_score,
                'L3' => $layer3_score, 'L4' => $layer4_score,
                'total' => $total_yes_count
            )
        ));
    } catch (PDOException $e) {
        error_log('[save_survey] ' . $e->getMessage());
        echo json_encode(array('success' => false, 'error' => 'survey save failed'));
    }
}

// ─── Survey Summary (대시보드용 집계만; raw 응답·자유응답 텍스트는 반환하지 않음) ───
function handleSurveySummary($pdo, $input) {
    $expected = getenv('CHA_DASHBOARD_TOKEN') ?: '';
    if (empty($expected)) {
        echo json_encode(array('success' => false, 'error' => 'dashboard token not configured'));
        return;
    }
    $provided = '';
    if (isset($_SERVER['HTTP_X_DASHBOARD_TOKEN'])) $provided = $_SERVER['HTTP_X_DASHBOARD_TOKEN'];
    if (!$provided && isset($input['dashboard_token'])) $provided = $input['dashboard_token'];
    // timing-safe compare (PHP 5.4 호환 — hash_equals는 5.6+에만 있음)
    $eq = false;
    if (strlen($expected) === strlen($provided)) {
        $r = 0;
        for ($i = 0; $i < strlen($expected); $i++) $r |= ord($expected[$i]) ^ ord($provided[$i]);
        $eq = ($r === 0);
    }
    if (!$eq) {
        echo json_encode(array('success' => false, 'error' => 'invalid dashboard token'));
        return;
    }

    $components = array(
        'q06_digital_twin','q07_institution_id','q08_ai_disclosure',
        'q09_rag_grounding','q10_limit_admit','q11_warm_tone','q12_format_consistency',
        'q13_latency_pacing','q14_echo_guard','q15_esc_interrupt','q16_avatar_embodiment','q17_mode_switch',
        'q18_consent_ui','q19_guest_browse','q20_korean_ordinal','q21_visit_tracking','q22_tts_normalize','q23_kakao_redirect',
        'q24_overall_trust'
    );

    try {
        // 총 / 유효(=flag_too_fast=0)
        $totals = $pdo->query('SELECT COUNT(*) AS total, SUM(flag_too_fast=0) AS valid FROM survey_responses')->fetch();

        // 컴포넌트별 (NULL 제외 = 응답한 사람만 집계)
        $comp = array();
        foreach ($components as $c) {
            $row = $pdo->query("SELECT COUNT($c) AS n, SUM($c=1) AS yes FROM survey_responses WHERE flag_too_fast=0")->fetch();
            $n = (int)$row['n']; $yes = (int)$row['yes'];
            $comp[$c] = array(
                'n'       => $n,
                'yes'     => $yes,
                'no'      => $n - $yes,
                'yes_pct' => $n > 0 ? round($yes * 100.0 / $n, 1) : null
            );
        }

        // Layer 평균 (만점 대비 %)
        $layers_row = $pdo->query('SELECT AVG(layer1_score) AS a1, AVG(layer2_score) AS a2, AVG(layer3_score) AS a3, AVG(layer4_score) AS a4, AVG(total_yes_count) AS at FROM survey_responses WHERE flag_too_fast=0')->fetch();
        $layers = array(
            'L1' => array('avg' => $layers_row['a1'] !== null ? round($layers_row['a1'], 2) : null, 'max' => 3),
            'L2' => array('avg' => $layers_row['a2'] !== null ? round($layers_row['a2'], 2) : null, 'max' => 4),
            'L3' => array('avg' => $layers_row['a3'] !== null ? round($layers_row['a3'], 2) : null, 'max' => 5),
            'L4' => array('avg' => $layers_row['a4'] !== null ? round($layers_row['a4'], 2) : null, 'max' => 6),
            'total' => array('avg' => $layers_row['at'] !== null ? round($layers_row['at'], 2) : null, 'max' => 18)
        );

        // 인구통계 분포 (각 그룹별 응답 수 + 평균 점수)
        $by = function($pdo, $col) {
            $stmt = $pdo->query("SELECT $col AS k, COUNT(*) AS n, ROUND(AVG(total_yes_count),2) AS avg_total, ROUND(AVG(q24_overall_trust)*100,1) AS q24_yes_pct FROM survey_responses WHERE flag_too_fast=0 AND $col IS NOT NULL GROUP BY $col ORDER BY n DESC");
            return $stmt->fetchAll();
        };
        $demographics = array(
            'grade'  => $by($pdo, 'grade'),
            'gender' => $by($pdo, 'gender'),
            'mbti'   => $by($pdo, 'mbti'),
            'major1' => $by($pdo, 'major1'),
        );

        // 일별 추이
        $daily = $pdo->query("SELECT DATE(submitted_at) AS d, COUNT(*) AS n, ROUND(AVG(total_yes_count),2) AS avg_total FROM survey_responses WHERE flag_too_fast=0 GROUP BY DATE(submitted_at) ORDER BY d")->fetchAll();

        // 점수 분포 (총점 0~18 히스토그램, 3점 단위 구간)
        $hist = $pdo->query("SELECT FLOOR(total_yes_count/3)*3 AS bucket_lo, COUNT(*) AS n FROM survey_responses WHERE flag_too_fast=0 GROUP BY bucket_lo ORDER BY bucket_lo")->fetchAll();

        echo json_encode(array(
            'success'      => true,
            'as_of'        => date('c'),
            'total'        => (int)$totals['total'],
            'valid'        => (int)$totals['valid'],
            'components'   => $comp,
            'layers'       => $layers,
            'demographics' => $demographics,
            'daily'        => $daily,
            'score_hist'   => $hist
        ), JSON_UNESCAPED_UNICODE);
    } catch (PDOException $e) {
        error_log('[survey_summary] ' . $e->getMessage());
        echo json_encode(array('success' => false, 'error' => 'survey summary failed'));
    }
}

// ─── Usage Summary (사용자/세션/메시지 집계 — 채팅 본문은 노출하지 않음) ───
function handleUsageSummary($pdo, $input) {
    // survey_summary와 동일한 dashboard token 게이트 사용
    $expected = getenv('CHA_DASHBOARD_TOKEN') ?: '';
    if (empty($expected)) {
        echo json_encode(array('success' => false, 'error' => 'dashboard token not configured'));
        return;
    }
    $provided = '';
    if (isset($_SERVER['HTTP_X_DASHBOARD_TOKEN'])) $provided = $_SERVER['HTTP_X_DASHBOARD_TOKEN'];
    if (!$provided && isset($input['dashboard_token'])) $provided = $input['dashboard_token'];
    $eq = false;
    if (strlen($expected) === strlen($provided)) {
        $r = 0;
        for ($i = 0; $i < strlen($expected); $i++) $r |= ord($expected[$i]) ^ ord($provided[$i]);
        $eq = ($r === 0);
    }
    if (!$eq) {
        echo json_encode(array('success' => false, 'error' => 'invalid dashboard token'));
        return;
    }

    try {
        // 1) Totals KPI
        $totals = $pdo->query("
            SELECT
              (SELECT COUNT(*) FROM users) AS users_total,
              (SELECT COUNT(*) FROM users WHERE kakao_id IS NOT NULL) AS users_kakao,
              (SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL) AS users_email,
              (SELECT COUNT(DISTINCT session_id) FROM chat_logs) AS sessions_total,
              (SELECT COUNT(*) FROM chat_logs) AS messages_total,
              (SELECT COUNT(*) FROM chat_logs WHERE role='user') AS user_messages,
              (SELECT COUNT(*) FROM chat_logs WHERE role='assistant') AS bot_messages,
              (SELECT COUNT(*) FROM chat_logs WHERE user_id IS NULL) AS anon_messages,
              (SELECT COUNT(DISTINCT session_id) FROM chat_logs WHERE user_id IS NULL) AS anon_sessions
        ")->fetch();

        // 2) 평균 세션 체류 시간 (분)
        $sessAvg = $pdo->query("
            SELECT AVG(secs) AS avg_seconds, AVG(turns) AS avg_turns
            FROM (
              SELECT session_id, TIMESTAMPDIFF(SECOND, MIN(created_at), MAX(created_at)) AS secs,
                     SUM(role='user') AS turns
              FROM chat_logs
              GROUP BY session_id
              HAVING COUNT(*) >= 2
            ) t
        ")->fetch();

        // 3) 일별 신규 가입 + 일별 활성(채팅 보낸 사람) — 두 시리즈 별도 산출 후 클라가 합치도록 한 배열로
        $signups = $pdo->query("SELECT DATE(created_at) AS d, COUNT(*) AS n FROM users GROUP BY DATE(created_at) ORDER BY d")->fetchAll();
        $activity = $pdo->query("SELECT DATE(created_at) AS d, COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT user_id) AS active_users FROM chat_logs GROUP BY DATE(created_at) ORDER BY d")->fetchAll();

        // 4) 세션당 사용자 턴 분포
        $turnHist = $pdo->query("
            SELECT
              SUM(turns=1)              AS bin_1,
              SUM(turns=2)              AS bin_2,
              SUM(turns=3)              AS bin_3,
              SUM(turns BETWEEN 4 AND 5) AS bin_4_5,
              SUM(turns BETWEEN 6 AND 10) AS bin_6_10,
              SUM(turns >= 11)          AS bin_11p
            FROM (SELECT session_id, SUM(role='user') AS turns FROM chat_logs GROUP BY session_id) t
        ")->fetch();

        // 5) 시간대 (KST 기준 0-23)
        $hourly = $pdo->query("SELECT HOUR(created_at) AS h, COUNT(*) AS n FROM chat_logs WHERE role='user' GROUP BY HOUR(created_at) ORDER BY h")->fetchAll();

        // 6) 재방문 분포 (visit_count)
        $revisit = $pdo->query("SELECT visit_count AS vc, COUNT(*) AS n FROM users GROUP BY visit_count ORDER BY vc")->fetchAll();

        // 7) 가입 종류 분포 — 이미 totals에서 산출됨

        // 8) 사용자 활동 Top 10 (id + 이름 + 로그인 종류 + 메시지/세션/방문/마지막 로그인)
        //    이메일/kakao_id는 노출하지 않음 (PII 최소화)
        $topUsers = $pdo->query("
            SELECT
              u.id,
              u.name,
              CASE WHEN u.kakao_id IS NOT NULL THEN 'kakao'
                   WHEN u.email IS NOT NULL THEN 'email'
                   ELSE 'other' END AS login_type,
              u.visit_count,
              u.last_login,
              (SELECT COUNT(*) FROM chat_logs c WHERE c.user_id=u.id) AS msgs,
              (SELECT COUNT(*) FROM chat_logs c WHERE c.user_id=u.id AND c.role='user') AS user_msgs,
              (SELECT COUNT(DISTINCT session_id) FROM chat_logs c WHERE c.user_id=u.id) AS sessions
            FROM users u
            ORDER BY (SELECT COUNT(*) FROM chat_logs c WHERE c.user_id=u.id) DESC
            LIMIT 10
        ")->fetchAll();

        echo json_encode(array(
            'success'  => true,
            'as_of'    => date('c'),
            'totals'   => array(
                'users_total'    => (int)$totals['users_total'],
                'users_kakao'    => (int)$totals['users_kakao'],
                'users_email'    => (int)$totals['users_email'],
                'sessions_total' => (int)$totals['sessions_total'],
                'messages_total' => (int)$totals['messages_total'],
                'user_messages'  => (int)$totals['user_messages'],
                'bot_messages'   => (int)$totals['bot_messages'],
                'anon_messages'  => (int)$totals['anon_messages'],
                'anon_sessions'  => (int)$totals['anon_sessions']
            ),
            'session_avg' => array(
                'seconds' => $sessAvg['avg_seconds'] !== null ? round($sessAvg['avg_seconds'], 1) : null,
                'minutes' => $sessAvg['avg_seconds'] !== null ? round($sessAvg['avg_seconds'] / 60.0, 2) : null,
                'turns'   => $sessAvg['avg_turns']   !== null ? round($sessAvg['avg_turns'], 2) : null
            ),
            'signups'   => $signups,
            'activity'  => $activity,
            'turn_hist' => $turnHist,
            'hourly'    => $hourly,
            'revisit'   => $revisit,
            'top_users' => $topUsers
        ), JSON_UNESCAPED_UNICODE);
    } catch (PDOException $e) {
        error_log('[usage_summary] ' . $e->getMessage());
        echo json_encode(array('success' => false, 'error' => 'usage summary failed'));
    }
}
