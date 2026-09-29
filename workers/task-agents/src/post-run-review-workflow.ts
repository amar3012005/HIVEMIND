import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import type { HivemindTaskAgent } from "./agent";
import type { PostRunReviewPacket, PostRunJevReview } from "./post-run-jev";

/** Advisory work follows the terminal WorkRun on its own durable timeline.
 * The packet identifies the completed run, so a later room turn cannot change
 * the review's sources, employee, or private-memory scope. */
export class PostRunReviewWorkflow extends ThinkWorkflow<HivemindTaskAgent, PostRunReviewPacket> {
  async run(event: AgentWorkflowEvent<PostRunReviewPacket>, step: ThinkWorkflowStep): Promise<PostRunJevReview> {
    const packet = event.payload;
    const durable = step as ThinkWorkflowStep & { do<T>(name: string, callback: () => Promise<T>): Promise<T> };
    const review = await durable.do<PostRunJevReview>("evaluate-post-run-jev", () => this.agent.evaluatePostRunReviewPacket(packet));
    await durable.do("save-reviewed-operating-learnings", () => this.agent.saveReviewedOperatingLearnings(packet, review));
    return review;
  }
}
