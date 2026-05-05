import { useState, useMemo, useRef, useEffect } from 'react'
import styles from './SurveyModal.module.css'
import { saveSurvey } from '../lib/api'
import { TRUST_QUESTIONS, OVERALL_QUESTION, LAYER_LABELS, MAJORS, MBTI_LIST } from '../lib/trustComponents'

const GRADE_OPTIONS = [
  { value: '1', label: '1학년' },
  { value: '2', label: '2학년' },
  { value: '3', label: '3학년' },
  { value: '4', label: '4학년' },
  { value: 'etc', label: '기타' },
]
const GENDER_OPTIONS = [
  { value: 'female', label: '여' },
  { value: 'male',   label: '남' },
  { value: 'no_answer', label: '응답하지 않음' },
]

function isKakaoUA() {
  if (typeof navigator === 'undefined') return false
  return /KAKAOTALK/i.test(navigator.userAgent || '')
}

export default function SurveyModal({
  open,
  onClose,
  sessionId,
  modesUsed = [],          // ['ftf','sts','ttt']
  visitCount = 1,
}) {
  const [grade, setGrade]   = useState('')
  const [gender, setGender] = useState('')
  const [mbti, setMbti]     = useState('')
  const [major1, setMajor1] = useState('')
  const [major2, setMajor2] = useState('none')
  const [answers, setAnswers] = useState({})    // { q06_...: 1|0|null }
  const [overall, setOverall] = useState(null)  // 1|0|null
  const [freePos, setFreePos] = useState('')
  const [freeNeg, setFreeNeg] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const startedAtRef = useRef(0)

  const usedVoice = modesUsed.includes('ftf') || modesUsed.includes('sts')
  const usedVideo = modesUsed.includes('ftf')
  const isRevisit = visitCount >= 2
  const fromKakao = useMemo(() => isKakaoUA(), [])

  // 조건부 문항 활성/비활성
  const isQuestionApplicable = (q) => {
    if (!q.condition) return true
    if (q.condition === 'voice')   return usedVoice
    if (q.condition === 'video')   return usedVideo
    if (q.condition === 'revisit') return isRevisit
    if (q.condition === 'kakao')   return fromKakao
    return true
  }

  useEffect(() => {
    if (open) {
      startedAtRef.current = Date.now()
      setDone(false)
      setError('')
    }
  }, [open])

  if (!open) return null

  const questionsByLayer = [1, 2, 3, 4].map(layer => ({
    layer,
    questions: TRUST_QUESTIONS.filter(q => q.layer === layer),
  }))

  const handleAnswer = (code, value) => {
    setAnswers(prev => ({ ...prev, [code]: value }))
  }

  const totalRequired = TRUST_QUESTIONS.filter(isQuestionApplicable).length + 1  // +1 = overall
  const totalAnswered =
    TRUST_QUESTIONS.filter(q => isQuestionApplicable(q) && (answers[q.code] === 0 || answers[q.code] === 1)).length
    + (overall === 0 || overall === 1 ? 1 : 0)

  const canSubmit =
    grade && gender && major1 && totalAnswered === totalRequired && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')

    const duration_seconds = Math.round((Date.now() - startedAtRef.current) / 1000)

    // 비활성화된 조건부 문항은 NULL 전송 (응답 안함)
    const questionPayload = {}
    TRUST_QUESTIONS.forEach(q => {
      questionPayload[q.code] = isQuestionApplicable(q) ? (answers[q.code] ?? null) : null
    })

    const payload = {
      session_id: sessionId || null,
      grade,
      gender,
      mbti: mbti || null,
      major1,
      major2: major2 === '' ? 'none' : major2,
      ...questionPayload,
      q24_overall_trust: overall,
      free_positive: freePos.trim() || null,
      free_negative: freeNeg.trim() || null,
      duration_seconds,
    }

    try {
      const r = await saveSurvey(payload)
      if (r?.success) {
        setDone(true)
      } else {
        setError(r?.error || '저장에 실패했어요. 잠시 후 다시 시도해 주세요.')
      }
    } catch (e) {
      setError('네트워크 오류가 발생했어요. 잠시 후 다시 시도해 주세요.')
    } finally {
      setSubmitting(false)
    }
  }

  const renderYesNo = (q, value, onSet) => {
    const applicable = isQuestionApplicable(q)
    return (
      <div key={q.code} className={`${styles.question} ${!applicable ? styles.inactive : ''}`}>
        <div className={styles.qLabel}>
          <span className={styles.qNum}>Q{q.num}.</span> {q.text}
          {q.conditionLabel && <span className={styles.condLabel}> ({q.conditionLabel})</span>}
        </div>
        <div className={styles.yesnoRow}>
          <button
            type="button"
            className={`${styles.yesnoBtn} ${value === 1 ? styles.yesActive : ''}`}
            disabled={!applicable}
            onClick={() => onSet(1)}
          >예</button>
          <button
            type="button"
            className={`${styles.yesnoBtn} ${value === 0 ? styles.noActive : ''}`}
            disabled={!applicable}
            onClick={() => onSet(0)}
          >아니오</button>
          {!applicable && <span className={styles.naMark}>해당 없음</span>}
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className={styles.overlay} role="dialog" aria-modal="true">
        <div className={styles.modal}>
          <div className={styles.doneBox}>
            <h2>응답해 주셔서 감사합니다!</h2>
            <p>의견은 봇 개선과 연구 목적으로 소중히 활용됩니다.</p>
            <button className={styles.primaryBtn} onClick={onClose}>닫기</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <header className={styles.header}>
          <h2>전공소개봇 사용 경험 설문</h2>
          <button className={styles.skipBtn} onClick={onClose}>건너뛰기</button>
        </header>

        <p className={styles.intro}>
          본 설문은 방금 사용하신 차의과학대학교 신입생 전공상담 AI 면담봇에 대한 익명 연구 설문입니다.
          개인을 식별할 수 있는 정보는 수집하지 않습니다. 약 4~5분 소요됩니다.
        </p>

        {/* Part I 인구통계 */}
        <section className={styles.section}>
          <h3>Part I. 기본 정보</h3>

          <div className={styles.demoRow}>
            <label>Q1. 학년</label>
            <div className={styles.chipRow}>
              {GRADE_OPTIONS.map(o => (
                <button key={o.value} type="button"
                  className={`${styles.chip} ${grade === o.value ? styles.chipActive : ''}`}
                  onClick={() => setGrade(o.value)}>{o.label}</button>
              ))}
            </div>
          </div>

          <div className={styles.demoRow}>
            <label>Q2. 성별</label>
            <div className={styles.chipRow}>
              {GENDER_OPTIONS.map(o => (
                <button key={o.value} type="button"
                  className={`${styles.chip} ${gender === o.value ? styles.chipActive : ''}`}
                  onClick={() => setGender(o.value)}>{o.label}</button>
              ))}
            </div>
          </div>

          <div className={styles.demoRow}>
            <label>Q3. MBTI <span className={styles.optional}>(선택)</span></label>
            <select className={styles.select} value={mbti} onChange={e => setMbti(e.target.value)}>
              <option value="">모름 / 응답하지 않음</option>
              {MBTI_LIST.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          <div className={styles.demoRow}>
            <label>Q4. 1전공</label>
            <select className={styles.select} value={major1} onChange={e => setMajor1(e.target.value)}>
              <option value="">선택해 주세요</option>
              {MAJORS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          <div className={styles.demoRow}>
            <label>Q5. 2전공</label>
            <select className={styles.select} value={major2} onChange={e => setMajor2(e.target.value)}>
              <option value="none">없음</option>
              {MAJORS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </section>

        {/* Part II 18문항 */}
        <section className={styles.section}>
          <h3>Part II. 봇 경험 평가 (18문항)</h3>
          <p className={styles.partIntro}>
            본인이 직접 느끼신 그대로 <strong>예 / 아니오</strong> 중 하나를 선택해 주세요.
          </p>
          {questionsByLayer.map(({ layer, questions }) => (
            <div key={layer} className={styles.layerBlock}>
              <h4 className={styles.layerTitle}>Layer {layer}. {LAYER_LABELS[layer]}</h4>
              {questions.map(q => renderYesNo(q, answers[q.code] ?? null, (v) => handleAnswer(q.code, v)))}
            </div>
          ))}
        </section>

        {/* Part III 전반 신뢰 */}
        <section className={styles.section}>
          <h3>Part III. 전반적인 신뢰</h3>
          {renderYesNo(OVERALL_QUESTION, overall, setOverall)}
        </section>

        {/* Part IV 자유응답 */}
        <section className={styles.section}>
          <h3>Part IV. 자유 의견 <span className={styles.optional}>(선택)</span></h3>
          <div className={styles.freeRow}>
            <label>Q25. 가장 신뢰가 갔던 순간이나 기능은 무엇이었나요?</label>
            <textarea
              className={styles.textarea}
              rows={3}
              value={freePos}
              onChange={e => setFreePos(e.target.value)}
              maxLength={2000}
            />
          </div>
          <div className={styles.freeRow}>
            <label>Q26. 반대로 가장 신뢰가 떨어졌거나 어색했던 순간은 언제였나요?</label>
            <textarea
              className={styles.textarea}
              rows={3}
              value={freeNeg}
              onChange={e => setFreeNeg(e.target.value)}
              maxLength={2000}
            />
          </div>
        </section>

        {error && <div className={styles.error}>{error}</div>}

        <footer className={styles.footer}>
          <span className={styles.progress}>
            응답 {totalAnswered}/{totalRequired}
          </span>
          <button
            className={styles.primaryBtn}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? '제출 중…' : '제출하기'}
          </button>
        </footer>
      </div>
    </div>
  )
}
