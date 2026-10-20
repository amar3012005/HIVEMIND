# Runtime attention notifications

Legacy notify/wake receipts retain existing notification behavior. A native decision receipt with assessmentVersion=1, action=wake and notification=runtime is delivered and persisted normally, but does not create an immediate workspace alert. Runtime owns subsequent outcome/blocker notification. Notify still alerts when autonomous waking is unavailable. No changes to consent, classification, subscriptions, retries or Control.
