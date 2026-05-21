import React, { useState } from 'react';
import styles from './AgentEvaluationForm.module.css';

/**
 * AgentEvaluationForm
 *
 * Captures user feedback on agent responses to feed the meta-agent improvement loop.
 * Data flows: User rating → Archive → Meta-agent analysis → Variant proposal → A/B test
 */
const AgentEvaluationForm = ({
  agentId,
  agentName,
  taskId,
  responseText,
  onEvaluationSubmit
}) => {
  const [rating, setRating] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (rating === null) {
      setError('Please select a rating');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/agents/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          agent_name: agentName,
          task_id: taskId,
          response_text: responseText,
          rating: rating,
          feedback_text: feedback,
          timestamp: new Date().toISOString(),
          evaluated_at: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`Evaluation failed: ${response.statusText}`);
      }

      const result = await response.json();

      // Reset form
      setRating(null);
      setFeedback('');

      // Notify parent
      if (onEvaluationSubmit) {
        onEvaluationSubmit({
          evaluation_id: result.evaluation_id,
          score: result.score,
          improvement_opportunity: result.improvement_opportunity,
        });
      }

    } catch (err) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const ratingDescriptions = {
    5: '👏 Excellent - Exceeded expectations',
    4: '👍 Good - Met expectations',
    3: '😐 Okay - Acceptable but could improve',
    2: '👎 Poor - Fell short of expectations',
    1: '❌ Failed - Did not work',
  };

  return (
    <div className={styles.evaluationForm}>
      <h3>Rate {agentName}'s Response</h3>

      <div className={styles.responsePreview}>
        <p className={styles.label}>Agent Response:</p>
        <blockquote className={styles.response}>
          {responseText.substring(0, 200)}
          {responseText.length > 200 ? '...' : ''}
        </blockquote>
      </div>

      <form onSubmit={handleSubmit}>
        <div className={styles.ratingSection}>
          <p className={styles.label}>How would you rate this response?</p>

          <div className={styles.ratingOptions}>
            {[5, 4, 3, 2, 1].map((value) => (
              <label key={value} className={styles.ratingLabel}>
                <input
                  type="radio"
                  name="rating"
                  value={value}
                  checked={rating === value}
                  onChange={() => setRating(value)}
                  disabled={isSubmitting}
                />
                <span className={`${styles.ratingValue} ${rating === value ? styles.selected : ''}`}>
                  {value} - {ratingDescriptions[value]}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className={styles.feedbackSection}>
          <label className={styles.label} htmlFor="feedback">
            What could improve? (optional)
          </label>
          <textarea
            id="feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g., 'Response was too verbose' or 'Missed key point about...'"
            maxLength={500}
            disabled={isSubmitting}
            className={styles.textarea}
          />
          <small>{feedback.length}/500</small>
        </div>

        {error && (
          <div className={styles.error}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting || rating === null}
          className={styles.submitButton}
        >
          {isSubmitting ? 'Submitting...' : 'Submit Evaluation'}
        </button>
      </form>

      <div className={styles.helpText}>
        <p>
          💡 Your feedback helps {agentName} improve. The system will analyze patterns
          and propose enhancements in the next iteration.
        </p>
      </div>
    </div>
  );
};

export default AgentEvaluationForm;
