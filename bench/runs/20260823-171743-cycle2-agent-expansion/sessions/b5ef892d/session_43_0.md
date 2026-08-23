# session sharegpt_rXUzPzR_0 — 2023-04-29 (2023/04/29 (Sat) 16:55)

date: 2023/04/29 (Sat) 16:55
iso_date: 2023-04-29

user: what are the best practices for setting up Parent accounts / account heirachies in salesforce

assistant: Setting up Parent accounts or account hierarchies in Salesforce is crucial for managing and tracking relationships between accounts, such as subsidiaries, branches, or other related organizations. Here are some best practices to follow when setting up Parent accounts or account hierarchies in Salesforce:

1. Plan your account hierarchy: Before setting up the hierarchy, define your organizational structure and understand the relationships between various accounts. This ensures a logical and easy-to-navigate account hierarchy.
2. Use Parent Accounts: In Salesforce, use the Parent Account field to link child accounts to their parent accounts. This allows you to build a hierarchical relationship between accounts and easily view related accounts on the Account Detail page.
3. Use the Role Hierarchy: The role hierarchy in Salesforce defines the visibility and access that users have to account records. Align the role hierarchy with your account hierarchy to maintain data access and visibility control.
4. Define a clear naming convention: Establish a consistent naming convention for accounts to make it easier to search and identify related accounts. Include relevant details in the account name, such as the company name, branch location, or division.
5. Keep account hierarchies manageable: Avoid creating overly complex account hierarchies, as this can make it difficult for users to navigate and manage accounts. Ideally, limit the hierarchy depth to 3-5 levels.
6. Use Custom Fields and Record Types: Create custom fields and record types to capture additional information about accounts and differentiate between various types of accounts in your hierarchy.
7. Set up sharing rules: Configure sharing rules to grant users access to the appropriate account records based on their role or other criteria. This helps maintain data security and ensures users can access the information they need.
8. Utilize Reports and Dashboards: Use Salesforce reports and dashboards to visualize and analyze the performance of accounts in the hierarchy. This helps you monitor key metrics and gain insights into account performance.
9. Keep data clean and up-to-date: Regularly review and update account information to maintain accurate and current data. Deduplicate accounts and merge duplicate records to ensure data integrity.
10. Train and support users: Provide training and documentation to help users understand the account hierarchy, naming conventions, and how to navigate and manage accounts in Salesforce.

By following these best practices, you can create a well-organized and efficient account hierarchy in Salesforce that aligns with your business structure and supports your sales, service, and marketing efforts.

user: Set up sharing rules: Configure sharing rules to grant users access to the appropriate account records based on their role or other criteria. This helps maintain data security and ensures users can access the information they need.

- explain this more pls

assistant: Certainly! Sharing rules in Salesforce are used to grant specific groups of users access to records that they might not have access to through the role hierarchy or organization-wide default (OWD) settings. Sharing rules help maintain data security while ensuring that users can access the information they need to perform their job functions effectively.

Here's a more in-depth explanation of sharing rules in Salesforce:

1. Organization-Wide Defaults (OWD): OWD settings define the baseline level of access for all records in an object. You can choose from Private, Public Read Only, or Public Read/Write for each object. Private is the most restrictive setting, while Public Read/Write is the least restrictive.
2. Role Hierarchy: The role hierarchy in Salesforce defines the levels of visibility and access that users have to records based on their role in the organization. Users in higher roles can access the records owned by users in lower roles, but not vice versa.

When the OWD settings and role hierarchy do not provide the desired level of access to records for specific groups of users, you can use sharing rules to extend access based on criteria like role, public group, or territory.

There are two types of sharing rules in Salesforce:

A. Criteria-based sharing rules: These rules grant access to records based on specific criteria or conditions. For example, if you want to share all accounts in a specific region with a group of users, you can create a criteria-based sharing rule with a condition like "Region equals 'East Coast'" and then share those records with the desired group.

B. Owner-based sharing rules: These rules grant access to records based on the record owner's role, group, or territory. For example, you can create a rule to share all accounts owned by users in the "Sales" role with a specific public group.

To set up sharing rules in Salesforce:

1. Navigate to Setup.
2. In the Quick Find box, type "Sharing Settings."
3. Click on "Sharing Settings" in the search results.
4. Scroll down to the object for which you want to create a sharing rule (e.g., Account).
5. Click "New" next to the appropriate sharing rule type (criteria-based or owner-based).
6. Define the rule by

user: How do you make sure a salesperson is assigned all chil accounts in a parent account

assistant: To ensure that a salesperson is assigned to all child accounts within a parent account, you can create an automation process using Process Builder. This process will automatically update the owner of the child accounts to match the owner of the parent account whenever a new child account is created or an existing child account's parent account is changed. Here's how to set up the process:

1. Navigate to Setup.
2. In the Quick Find box, type "Process Builder."
3. Click on "Process Builder" in the search results.
4. Click "New" to create a new process.
5. Give your process a name, such as "Assign Salesperson to Child Accounts," and provide a brief description.
6. Set the process to start "when a record changes."
7. Click "Save" and then click "Add Object."
8. Choose the "Account" object and select "when a record is created or edited."
9. Click "Save" and then click "Add Criteria."
10. Give your criteria a name, such as "Parent Account Changed."
11. Set the criteria for executing actions to "Conditions are met."
12. Add a condition to check if the "Parent Account" field has been changed:

a. Field: [Account].ParentId
b. Operator: "Is changed"
c. Type: "Boolean"
d. Value: "True"

1. Click "Save" and then click "Add Action."
2. Choose the "Update Records" action type.
3. Give your action a name, such as "Update Child Account Owner."
4. For "Select a record related to the Account," choose "Account.Parent Account" from the dropdown.
5. Click "Add Row" to add the field update for the "Owner" field:

a. Field: OwnerId
b. Type: "Reference"
c. Value: [Account.Parent].OwnerId

1. Click "Save" and then click "Activate" to activate the process.

With this process in place, when a new child account is created or an existing child account's parent account is changed, the owner of the child account will automatically be updated to match the owner of the parent account. This ensures that the salesperson assigned to the parent account is also assigned to all child accounts.

user: This is brilliant thank you. How do you ensure that:

1. if a parent account is changed, all child accounts are swapped too, as well as when the child is swapped 
2. only change the account owner in all cases when the existing account owner has the role "Sales"

assistant: To ensure that child accounts' owners are updated when a parent account is changed, and the change is limited to when the existing account owner has the "Sales" role, you can create an Apex trigger. An Apex trigger allows for more complex conditions and actions compared to Process Builder.

Follow these steps to create the Apex trigger:

1. Navigate to Setup.
2. In the Quick Find box, type "Apex Triggers."
3. Click on "Apex Triggers" in the search results.
4. Click the "New Trigger" button.
5. Give your trigger a name, such as "UpdateChildAccountsOnParentChange," and choose the "Account" object.
6. In the trigger editor, enter the following Apex code:
```Apex
trigger UpdateChildAccountsOnParentChange on Account (after update) {
    // Get a set of updated Account IDs
    Set<Id> updatedAccountIds = new Set<Id>();
    for (Account updatedAccount : Trigger.new) {
        Account oldAccount = Trigger.oldMap.get(updatedAccount.Id);
        if (updatedAccount.OwnerId != oldAccount.OwnerId && updatedAccount.ParentId == null) {
            updatedAccountIds.add(updatedAccount.Id);
        }
    }

    // Check if any accounts were updated
    if (!updatedAccountIds.isEmpty()) {
        // Get the Sales role ID
        UserRole salesRole = [SELECT Id FROM UserRole WHERE Name = 'Sales' LIMIT 1];

        // Get all child accounts related to updated parent accounts
        List<Account> childAccountsToUpdate = [
            SELECT Id, OwnerId, Owner.UserRoleId
            FROM Account
            WHERE ParentId IN :updatedAccountIds
        ];

        // Update the child accounts' owners if the current owner has the Sales role
        for (Account childAccount : childAccountsToUpdate) {
            if (childAccount.Owner.UserRoleId == salesRole.Id) {
                Account updatedParentAccount = Trigger.newMap.get(childAccount.ParentId);
                childAccount.OwnerId = updatedParentAccount.OwnerId;
            }
        }

        // Perform the update
        update childAccountsToUpdate;
    }
}
```
1. Click "Save" to create the trigger.

This Apex trigger will execute after an account update. It checks if the parent account's owner has changed and if the account has no parent itself (meaning it's a parent account). If these conditions are met, the trigger retrieves all child accounts and checks if the child account owner has the "Sales" role. If so, the child account owner is updated to match the parent account's owner.

Please note that deploying an Apex trigger requires knowledge of Salesforce development and the trigger should be tested in a sandbox environment before deploying to production. Additionally, make sure to write test classes to ensure that the trigger meets the required test coverage.
