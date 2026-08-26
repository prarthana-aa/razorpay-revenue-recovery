from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey, DateTime
from datetime import datetime
from .database import Base


class Batch(Base):
    __tablename__ = "batches"
    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    seed = Column(Integer, nullable=True)


class Transaction(Base):
    __tablename__ = "transactions"
    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("batches.id"), index=True)
    day = Column(Integer)
    segment_key = Column(String, index=True)
    issuer = Column(String)
    method = Column(String)
    amount = Column(Float)
    status = Column(String)  # "success" | "failed"
    failure_code = Column(String, nullable=True)


class Case(Base):
    __tablename__ = "cases"
    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("batches.id"), index=True)
    segment_key = Column(String)
    segment_label = Column(String)
    baseline_rate = Column(Float)
    current_rate = Column(Float)
    window_attempts = Column(Integer)
    window_failed = Column(Integer)
    avg_amount = Column(Float)
    top_cause = Column(String, nullable=True)
    top_confidence = Column(Float, nullable=True)
    hypotheses_json = Column(String)
    status = Column(String, default="pending")
    reverted = Column(Boolean, default=False)
    recovered_amount = Column(Float, nullable=True)
    recovered_tx = Column(Integer, nullable=True)
    chosen_action = Column(String, nullable=True)


class TimelineEvent(Base):
    __tablename__ = "timeline_events"
    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(Integer, ForeignKey("cases.id"), index=True)
    ts = Column(DateTime, default=datetime.utcnow)
    event = Column(String)
