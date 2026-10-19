-- Complete prior confirmed account-erasure operations; never touch a live account.
DELETE FROM hivemind.system_email_deliveries d USING hivemind.account_erasure_operations e
 WHERE d.user_id=e.user_id AND e.state='completed'
 AND NOT EXISTS(SELECT 1 FROM hivemind.users u WHERE u.id=e.user_id);
