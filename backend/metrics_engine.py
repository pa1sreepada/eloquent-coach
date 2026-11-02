import logging
from database import SessionLocal, Transcript, Metrics
import datetime

logger = logging.getLogger(__name__)

class MetricsEngine:
    def __init__(self):
        pass

    def update_metrics(self, meeting_id: int):
        """
        Calculates simple metrics like talk time, words per minute, based on transcripts.
        """
        db = SessionLocal()
        try:
            # Load all transcripts for collective metrics (Wait Time, Talk Ratio)
            all_transcripts = db.query(Transcript).filter(Transcript.meeting_id == meeting_id).order_by(Transcript.timestamp.asc()).all()
            if not all_transcripts:
                return None
            
            # Filter for User-only transcripts for personal coaching metrics
            user_transcripts = [t for t in all_transcripts if t.speaker == "Me"]

            user_words = 0
            other_words = 0
            filler_count = 0
            user_questions = 0
            user_sentences = 0
            we_count = 0
            i_count = 0
            future_count = 0
            
            # For Wait Time calculation
            speaker_changes = [] # list of (end_time, start_time) where end was user question
            
            # Load filler words from DB
            from database import AppConfig, Insight, Meeting
            filler_conf = db.query(AppConfig).filter(AppConfig.key == "filler_words").first()
            if filler_conf:
                fillers = [f.strip() for f in filler_conf.value.split(",")]
            else:
                fillers = ["um", "uh", "ah", "like", "so", "actually", "basically", "literally", "you know"]
            
            # Pronoun/Future keyword lists
            WE_WORDS = {"we", "us", "our", "team", "together"}
            I_WORDS = {"i", "me", "my", "mine"}
            FUTURE_WORDS = {"will", "going", "next", "future", "roadmap", "target", "goal", "forward", "tomorrow"}

            # 1. Calculate Personal Metrics (Me only)
            for t in user_transcripts:
                text_lower = t.text.lower()
                words = text_lower.split()
                user_words += len(words)
                
                # Count fillers
                for filler in fillers:
                    filler_count += text_lower.count(f" {filler} ") + (1 if text_lower.startswith(f"{filler} ") else 0) + (1 if text_lower.endswith(f" {filler}") else 0)
                
                # Sentence/Question count
                user_sentences += text_lower.count(".") + text_lower.count("?") + text_lower.count("!")
                user_questions += text_lower.count("?")
                
                # Pronoun counts
                for w in words:
                    clean_w = w.strip(".,?!")
                    if clean_w in WE_WORDS: we_count += 1
                    if clean_w in I_WORDS: i_count += 1
                    if clean_w in FUTURE_WORDS: future_count += 1

            # 2. Calculate Collective Metrics (Interactions)
            for i, t in enumerate(all_transcripts):
                text_lower = t.text.lower()
                words = text_lower.split()
                
                if t.speaker != "Me":
                    other_words += len(words)
                
                # Wait Time Logic: If 'Me' asked a question, check when next speaker started
                if t.speaker == "Me" and "?" in t.text and i < len(all_transcripts) - 1:
                    next_t = all_transcripts[i+1]
                    if next_t.speaker != "Me":
                        wait = (next_t.timestamp - t.timestamp).total_seconds()
                        if 0 < wait < 15:
                            speaker_changes.append(wait)
            
            # Simple heuristic for talk time: 150 words = 1 minute
            talk_time_minutes = user_words / 150.0
            listen_time_minutes = other_words / 150.0
            total_time = talk_time_minutes + listen_time_minutes
            
            pacing = user_words / talk_time_minutes if talk_time_minutes > 0 else 0
            
            # Confidence Score: Pacing stability (optimal between 130-160 WPM)
            confidence_score = 10.0 - (min(30, abs(145 - pacing)) / 3) if pacing > 0 else 0

            # NEW ADVANCED METRICS
            wait_time_avg = sum(speaker_changes) / len(speaker_changes) if speaker_changes else 0
            question_ratio = (user_questions / user_sentences) if user_sentences > 0 else 0
            we_i_ratio = (we_count / (i_count + we_count)) if (i_count + we_count) > 0 else 0.5
            future_focus_pct = (future_count / (user_words / 10)) * 100 if user_words > 0 else 0 # normalized to words
            
            # LPS Algorithm (Leadership Proficiency Score)
            # Weighted mix of all indicators
            clarity = max(0, 10 - (filler_count / 2))
            talk_ratio = (talk_time_minutes / total_time) if total_time > 0 else 0
            engagement = 10 - abs(0.4 - talk_ratio) * 20
            
            insight_count = db.query(Insight).filter(Insight.meeting_id == meeting_id).count()
            impact = min(10, insight_count * 2)
            
            lps_score = (clarity * 0.25) + (impact * 0.25) + (engagement * 0.15) + (confidence_score * 0.15) + (we_i_ratio * 10 * 0.1) + (min(10, wait_time_avg * 2) * 0.1)

            # Store metrics
            metric = db.query(Metrics).filter(Metrics.meeting_id == meeting_id).order_by(Metrics.timestamp.desc()).first()
            if not metric:
                metric = Metrics(meeting_id=meeting_id)
                db.add(metric)
            
            metric.talk_time = talk_time_minutes
            metric.listen_time = listen_time_minutes
            metric.pacing = pacing
            metric.filler_count = filler_count
            metric.confidence_score = confidence_score
            metric.wait_time_avg = wait_time_avg
            metric.question_ratio = question_ratio
            metric.we_i_ratio = we_i_ratio
            metric.future_focus_pct = future_focus_pct
            metric.timestamp = datetime.datetime.utcnow()
            
            # Update meeting-level score
            meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
            if meeting:
                meeting.lps_score = round(lps_score, 1)
            
            db.commit()
            db.refresh(metric)
            return metric
        except Exception as e:
            logger.error(f"Error calculating metrics: {e}")
            return None
        finally:
            db.close()
