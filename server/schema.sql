-- cha_interview_db 스키마
CREATE DATABASE IF NOT EXISTS cha_interview_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cha_interview_db;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kakao_id VARCHAR(64) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  password_hash VARCHAR(255) DEFAULT NULL,
  name VARCHAR(100) NOT NULL,
  visit_count INT DEFAULT 1,
  last_login DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kakao (kakao_id),
  UNIQUE KEY uniq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  session_id VARCHAR(64) NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  message TEXT NOT NULL,
  rag_hits TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_session (session_id),
  INDEX idx_created (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 신뢰설계 컴포넌트 평가 설문 (survey-draft v1: Yes/No 18문항 + 인구통계 5 + 자유 2)
CREATE TABLE IF NOT EXISTS survey_responses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  session_id VARCHAR(64) DEFAULT NULL,
  survey_version VARCHAR(16) DEFAULT 'v1',

  -- Part I 인구통계
  grade ENUM('1','2','3','4','etc') DEFAULT NULL,
  gender ENUM('female','male','no_answer') DEFAULT NULL,
  mbti CHAR(4) DEFAULT NULL,
  major1 VARCHAR(32) DEFAULT NULL,
  major2 VARCHAR(32) DEFAULT NULL,

  -- Part II 18문항 Yes/No (조건 미충족시 NULL)
  q06_digital_twin TINYINT(1) DEFAULT NULL,
  q07_institution_id TINYINT(1) DEFAULT NULL,
  q08_ai_disclosure TINYINT(1) DEFAULT NULL,
  q09_rag_grounding TINYINT(1) DEFAULT NULL,
  q10_limit_admit TINYINT(1) DEFAULT NULL,
  q11_warm_tone TINYINT(1) DEFAULT NULL,
  q12_format_consistency TINYINT(1) DEFAULT NULL,
  q13_latency_pacing TINYINT(1) DEFAULT NULL,
  q14_echo_guard TINYINT(1) DEFAULT NULL,
  q15_esc_interrupt TINYINT(1) DEFAULT NULL,
  q16_avatar_embodiment TINYINT(1) DEFAULT NULL,
  q17_mode_switch TINYINT(1) DEFAULT NULL,
  q18_consent_ui TINYINT(1) DEFAULT NULL,
  q19_guest_browse TINYINT(1) DEFAULT NULL,
  q20_korean_ordinal TINYINT(1) DEFAULT NULL,
  q21_visit_tracking TINYINT(1) DEFAULT NULL,
  q22_tts_normalize TINYINT(1) DEFAULT NULL,
  q23_kakao_redirect TINYINT(1) DEFAULT NULL,

  -- Part III 전반 신뢰 (Yes/No)
  q24_overall_trust TINYINT(1) DEFAULT NULL,

  -- 4-layer 합산 점수 (서버 자동 계산)
  layer1_score TINYINT DEFAULT NULL,   -- 0-3 (Q6-Q8)
  layer2_score TINYINT DEFAULT NULL,   -- 0-4 (Q9-Q12)
  layer3_score TINYINT DEFAULT NULL,   -- 0-5 (Q13-Q17)
  layer4_score TINYINT DEFAULT NULL,   -- 0-6 (Q18-Q23)
  total_yes_count TINYINT DEFAULT NULL, -- 0-18

  -- Part IV 자유응답 (선택)
  free_positive TEXT DEFAULT NULL,
  free_negative TEXT DEFAULT NULL,

  -- 메타
  user_agent VARCHAR(255) DEFAULT NULL,
  duration_seconds INT DEFAULT NULL,
  flag_too_fast TINYINT(1) DEFAULT 0,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_user (user_id),
  INDEX idx_session (session_id),
  INDEX idx_version (survey_version),
  INDEX idx_submitted (submitted_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
