"""Multi-employee orchestration layer.

Each Digital Employee runs as an `agentscope.agent.ReActAgent`, wrapped
in an `EmployeeWorker` adapter that carries role + reviewer metadata.
A `TeamRoom` drives one collaborative task across N workers using
`agentscope.pipeline.MsgHub` for peer-message broadcasting, with phase
sequencing modelled on MiroFish's CSI deep-research engine
(investigate → propose → review → revise → synthesize).
"""
from .team_room import TeamOutcome, TeamRoom, TeamTask
from .worker import EmployeeWorker, WorkerMessage

__all__ = [
    "EmployeeWorker",
    "WorkerMessage",
    "TeamRoom",
    "TeamTask",
    "TeamOutcome",
]
