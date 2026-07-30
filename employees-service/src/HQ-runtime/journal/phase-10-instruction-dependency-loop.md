# Phase 10: Instruction and dependency loop

HQ now treats user direction, capability dependencies, and waiting as durable
operating state instead of transient conversation copy.

## Runtime behavior

- The first wake after onboarding acknowledges a newly assigned company, loads
  its retained context, and begins diagnosis from that evidence.
- Standing instructions become persistent todos. New instructions extend the
  active Growth Plan; they do not erase completed work or prior decisions.
- Location-sensitive work uses an explicit location from the instruction and
  otherwise inherits the company profile location.
- Outreach work loads the `primary-outreach` skill and requires the Maps and
  Gmail capabilities before delegation.
- Missing capabilities create durable capability requests and pause only the
  dependent todo. The HQ UI opens the exact connector flow and rechecks the
  organization connection until the todo can resume.
- Connector resolution is recorded as a runtime event before the todo returns
  to the ready queue.

## Waiting policy

Sleeping is a governed checkpoint, not an idle model process. HQ states:

- which assigned work is complete or currently owned;
- which evidence has not materially changed;
- why the active Growth Stage requires its observation interval;
- which metrics will be compared at the checkpoint;
- the exact scheduled wake time; and
- which connector, specialist, campaign, instruction, or material performance
  events can wake it earlier.

A manual wake with no new evidence emits `No material change detected` and
keeps the existing checkpoint instead of replaying a monitor decision as new
work.

## Durable records

- `hq_instructions`: tenant-scoped standing directions and application state.
- `hq_todos`: ordered work with skill, location, capability, and work-order
  references.
- `hq_capability_requests`: unresolved and resolved connector dependencies.

Company replacement clears these records with the rest of the prior company's
HQ runtime state so onboarding cannot inherit another company's operating loop.
