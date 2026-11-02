from database import SessionLocal, Meeting, Metrics
import logging
from sqlalchemy import func
import datetime

logger = logging.getLogger(__name__)

class ReportGenerator:
    def __init__(self):
        pass

    def generate_daily_report(self, date_str: str):
        """Generates an aggregated report for a specific date (YYYY-MM-DD)"""
        db = SessionLocal()
        try:
            # Parse the date
            target_date = datetime.datetime.strptime(date_str, "%Y-%m-%d").date()
            
            # Query meetings for that day
            meetings = db.query(Meeting).filter(
                func.date(Meeting.start_time) == target_date
            ).all()
            
            if not meetings:
                return {
                    "date": date_str,
                    "count": 0,
                    "total_duration": 0,
                    "avg_talk_time": 0,
                    "avg_pacing": 0,
                    "highlights": "No meetings recorded for this day."
                }
            
            total_duration = 0
            all_talk_times = []
            all_pacings = []
            
            for m in meetings:
                if m.start_time and m.end_time:
                    duration = (m.end_time - m.start_time).total_seconds() / 60
                    total_duration += duration
                
                # Average metrics for this meeting
                meeting_metrics = db.query(
                    func.avg(Metrics.talk_time),
                    func.avg(Metrics.pacing)
                ).filter(Metrics.meeting_id == m.id).first()
                
                if meeting_metrics[0] is not None:
                    all_talk_times.append(meeting_metrics[0])
                if meeting_metrics[1] is not None:
                    all_pacings.append(meeting_metrics[1])
            
            avg_talk_time = sum(all_talk_times) / len(all_talk_times) if all_talk_times else 0
            avg_pacing = sum(all_pacings) / len(all_pacings) if all_pacings else 0
            
            # Simple synthesis of highlights based on meeting summaries
            highlights = [m.summary for m in meetings if m.summary]
            
            return {
                "date": date_str,
                "count": len(meetings),
                "total_duration": round(total_duration, 1),
                "avg_talk_time": round(avg_talk_time * 100, 1), # as percentage
                "avg_pacing": round(avg_pacing, 1),
                "highlights": highlights if highlights else ["No summaries generated for today's meetings."]
            }
        except Exception as e:
            logger.error(f"Error generating daily report: {e}")
            return {"error": str(e)}
        finally:
            db.close()
