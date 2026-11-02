from lm_studio_client import LMStudioClient
from database import SessionLocal, Transcript, Meeting
import logging

logger = logging.getLogger(__name__)

EXECUTIVE_SYNTHESIS_PROMPT = """You are a senior executive performance coach advising a C-suite leader.
Analyze the complete meeting transcript below and generate a structured Executive Briefing.

FORMAT YOUR RESPONSE EXACTLY AS FOLLOWS:

--- EXECUTIVE SUMMARY ---
Provide a 2-3 paragraph high-level synthesis focusing on strategic decisions made, key consensus points, and unaddressed risks.

--- ACTION ITEMS ---
List key commitments and action items in bullet points:
- Owner | Action Item | Target Timeline

--- STRATEGIC REROUTES ---
Identify exactly 3 moments where 'Me' (the leader) used weak, ambiguous, defensive, or tentative language. Provide an authoritative Executive Pivot and Strategic Rationale.
Format each reroute strictly on one line:
1. ORIGIN: [exact quote or weak statement] | ALTERNATIVE: [authoritative executive pivot] | RATIONALE: [strategic rationale]
2. ORIGIN: [weak statement] | ALTERNATIVE: [authoritative executive pivot] | RATIONALE: [strategic rationale]
3. ORIGIN: [weak statement] | ALTERNATIVE: [authoritative executive pivot] | RATIONALE: [strategic rationale]
"""

FIRESIDE_SYNTHESIS_PROMPT = """You are a senior executive leadership & communications coach.
Analyze the Fireside Chat / Guest Speaker session transcript below and generate a tailored Executive Moderation & Experiential Wisdom Briefing.

FORMAT YOUR RESPONSE EXACTLY AS FOLLOWS:

--- EXECUTIVE SUMMARY ---
Provide a 2-3 paragraph high-level synthesis capturing the guest speaker's core leadership philosophy, pivotal career/business inflection points shared, and key strategic takeaways for executive leadership.

--- ACTION ITEMS ---
List key mental models, leadership principles, and personal application steps to embody:
- Topic/Principle | Experiential Wisdom & Insights Shared | Personal Leadership Application

--- STRATEGIC REROUTES ---
Identify exactly 3 key moments during the moderation/discussion where 'Me' (the host/moderator) asked a surface-level, conversational, or polite question, OR missed an opportunity to probe deeper into the guest speaker's experience. Provide a High-Impact Probing Question/Pivot and Strategic Rationale detailing what to be intentional and mindful about as you learn from guest speakers.
Format each reroute strictly on one line:
1. ORIGIN: [moderator statement or surface-level probe] | ALTERNATIVE: [high-impact probing question/pivot] | RATIONALE: [mindful guidance on what to be intentional about when interviewing leaders]
2. ORIGIN: [moderator statement or probe] | ALTERNATIVE: [high-impact probing question/pivot] | RATIONALE: [mindful guidance on what to be intentional about]
3. ORIGIN: [moderator statement or probe] | ALTERNATIVE: [high-impact probing question/pivot] | RATIONALE: [mindful guidance on what to be intentional about]
"""

class PostMeetingSynthesis:
    def __init__(self, lm_client: LMStudioClient):
        self.lm_client = lm_client
        self.system_prompt = EXECUTIVE_SYNTHESIS_PROMPT

    async def generate_summary(self, meeting_id: int):
        db = SessionLocal()
        try:
            meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
            mode = meeting.mode if meeting else "General Executive"

            # Select prompt based on meeting mode
            if "Fireside" in mode or "Guest" in mode:
                prompt_to_use = FIRESIDE_SYNTHESIS_PROMPT
            else:
                prompt_to_use = EXECUTIVE_SYNTHESIS_PROMPT

            transcripts = db.query(Transcript).filter(Transcript.meeting_id == meeting_id).order_by(Transcript.timestamp.asc()).all()
            if not transcripts:
                return "No transcript available for synthesis."
            
            full_text = "\n".join([f"{t.speaker}: {t.text}" for t in transcripts])
            
            # Truncate if too long for LLM context window (smart head/tail sampling)
            MAX_CHARS = 8000
            if len(full_text) > MAX_CHARS:
                logger.info(f"Transcript too long ({len(full_text)} chars). Smart sampling for synthesis.")
                full_text = full_text[:4000] + "\n\n[... middle transcript truncated ...]\n\n" + full_text[-4000:]

            summary_raw = await self.lm_client.generate_insight(full_text, prompt_to_use)
            if not summary_raw:
                return "Failed to generate synthesis from LLM."
            
            # Structured parsing for meeting summary and strategic rerouting alternatives
            summary = summary_raw
            alternatives = ""
            
            if "--- STRATEGIC REROUTES ---" in summary_raw:
                parts = summary_raw.split("--- STRATEGIC REROUTES ---")
                summary = parts[0].replace("--- EXECUTIVE SUMMARY ---", "").strip()
                alternatives = parts[1].strip()
            elif "--- REROUTES ---" in summary_raw:
                parts = summary_raw.split("--- REROUTES ---")
                summary = parts[0].replace("--- SUMMARY ---", "").strip()
                alternatives = parts[1].strip()
            
            meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
            if meeting:
                meeting.summary = summary
                meeting.strategic_alternatives = alternatives
                db.commit()
                
            return summary_raw
        except Exception as e:
            logger.error(f"Error generating executive synthesis: {e}")
            return "Error generating synthesis."
        finally:
            db.close()

