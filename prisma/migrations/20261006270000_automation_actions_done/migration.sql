ALTER TABLE "AutomationJob" ADD COLUMN "customerActionsDone" "AutomationCustomerAction"[] NOT NULL DEFAULT ARRAY[]::"AutomationCustomerAction"[];
