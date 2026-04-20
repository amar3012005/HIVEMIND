import os
import sys
import json
import asyncio
import hashlib
from datetime import datetime

# Add the project root to sys.path
sys.path.insert(0, "/Users/amar/HIVE-MIND/MiroFish/backend")

from app.services.simulation_manager import SimulationManager
from app.services.simulation_csi_local import SimulationCSILocalStore
from app.config import Config

async def run_seed_search_test():
    print("Starting Seed Search simulation test...")
    
    simulation_id = "test_seed_search_v1"
    simulation_requirement = "Synthesize the latest research on transformer-alternative architectures"
    
    # Initialize manager
    manager = SimulationManager()
    csi_store = SimulationCSILocalStore()
    
    # Clean up previous test run if any
    sim_dir = csi_store._sim_dir(simulation_id)
    if os.path.exists(sim_dir):
        import shutil
        print(f"Cleaning up existing simulation directory: {sim_dir}")
        shutil.rmtree(sim_dir)
    
    # Mock some data for preparation
    # In a real scenario, we'd need a project_id and agents
    project_id = "test_project_1"
    agents = [
        {"agent_id": 1, "agent_name": "ResearchLead", "bio": "Expert in AI architectures", "research_role": "Synthesizer"},
        {"agent_id": 2, "agent_name": "TechAnalyst", "bio": "Specialist in State Space Models", "research_role": "Analyst"}
    ]
    
    # We will try to run the prepare logic specifically for the seed search
    # Step 3: Initialize CSI
    print("Step 1: Initializing CSI store...")
    os.makedirs(os.path.join(sim_dir, "csi"), exist_ok=True)
    
    # Write snapshot files that prepare expects
    csi_store._write_json(os.path.join(sim_dir, "csi", "profiles_snapshot.json"), agents)
    
    profiles_payload = agents
    csi_result = csi_store.initialize_from_prepare(
        simulation_id=simulation_id,
        project_id=project_id,
        graph_id="",
        simulation_requirement=simulation_requirement,
        document_text="",
        simulation_config={},
        profiles=profiles_payload,
        bootstrap_rounds=0,
    )
    
    print("Step 2: Running Seed Search logic...")
    # Manual extraction of the seed search logic from simulation_manager.py
    from app.utils.groq_native_client import GroqNativeClient
    
    groq_client = GroqNativeClient()
    seed_count = 0
    
    # The error was likely due to 'existing_sources' being None or unexpected structure
    existing_sources = csi_result.get("sources", []) or csi_store._load_sources_index(simulation_id).get("sources", [])
    print(f"Current existing sources count: {len(existing_sources)}")
    
    # Fix the error: ensure existing_ids is always a set even if existing_sources is empty
    existing_ids = {s.get("source_id") for s in existing_sources if s and s.get("source_id")}
    
    seed_queries = [
        f"{simulation_requirement[:80]} latest research",
        f"{simulation_requirement[:80]} Mamba RWKV Liquid neural networks State Space Models"
    ]
    
    found_architectures = []
    
    for sq in seed_queries:
        print(f"Searching for: {sq}")
        try:
            groq_results = groq_client.web_search(sq, max_results=5)
            print(f"Found {len(groq_results)} results from Groq")
            
            for r in groq_results:
                content = r.get('content', '')
                url = r.get('url', '')
                
                # Check for requested architectures
                for arch in ["Mamba", "RWKV", "Liquid Neural Network", "State Space Model", "SSM"]:
                    if arch.lower() in content.lower() or arch.lower() in r.get('title', '').lower():
                        if arch not in found_architectures:
                            found_architectures.append(arch)
                
                sid = f"csi_source_groq_seed_{hashlib.sha256((url + content).encode()).hexdigest()[:12]}"
                if sid not in existing_ids:
                    existing_sources.append({
                        "source_id": sid,
                        "source_type": "web",
                        "title": r.get("title", f"Groq Seed: {sq}"),
                        "url": url,
                        "content": content,
                        "summary": content[:500],
                        "origin": "groq_native_search",
                        "score": 0.9,
                        "agent_name": "SeedSearch",
                        "round_num": 0,
                        "timestamp": datetime.now().isoformat()
                    })
                    existing_ids.add(sid)
                    seed_count += 1
        except Exception as e:
            print(f"Error during search: {e}")

    print(f"Seed search completed. Total new seeds: {seed_count}")
    print(f"Architectures identified: {', '.join(found_architectures)}")
    
    # Persist the results
    print("Step 3: Persisting results to CSI index...")
    csi_store._save_sources_index(simulation_id, {"sources": existing_sources})
    
    # Verify persistence
    reloaded = csi_store._load_sources_index(simulation_id)
    print(f"Verified sources index. Total stored sources: {len(reloaded.get('sources', []))}")
    
    if seed_count > 0:
        print("SUCCESS: Seed search injected results correctly.")
    else:
        print("WARNING: No results found during seed search.")

if __name__ == "__main__":
    asyncio.run(run_seed_search_test())
