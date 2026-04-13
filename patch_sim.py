import re
with open("./MiroFish/backend/app/services/simulation_manager.py", "r") as f:
    code = f.read()

# Instead of failing if seed_count <= 0, we just log a warning.
code = code.replace("""                    if seed_count <= 0:
                        state.status = SimulationStatus.FAILED
                        state.error = (
                            "Web research source collection produced no sources. "
                            "Install tavily-python and verify TAVILY_API_KEY."
                        )
                        self._save_simulation_state(state)
                        logger.error(
                            "Seed search produced no sources for %s; failing prepare",
                            simulation_id,
                        )
                        if progress_callback:
                            progress_callback(
                                "collecting_sources",
                                100,
                                "Web research source collection failed. Please verify API keys.",
                                current=1, total=1,
                            )
                        return {"status": "error", "message": "Zero sources collected"}""",
                    """                    if seed_count <= 0:
                        logger.warning("Seed search produced no sources, but continuing with empty start.")""")

with open("./MiroFish/backend/app/services/simulation_manager.py", "w") as f:
    f.write(code)
