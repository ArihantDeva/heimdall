# session sharegpt_OLkkH3L_41 — 2023-05-23 (2023/05/23 (Tue) 12:19)

date: 2023/05/23 (Tue) 12:19
iso_date: 2023-05-23

assistant: Here is a new `resourceaccesses.json` file for your policy and resources that includes a variety of assignments with constraints, as well as some assignments where the '\*' is specified for the resource:
```json
{
  "user1": [
    {
      "ResourceID": "*",
      "ResourceType": "Invoice",
      "AzLocalRightName": "Read",
      "Constraints": {
        "Country": ["Norway", "Sweden"]
      }
    },
    {
      "ResourceID": "e56fa32c-9601-4c88-b9f9-02d66e0efbdb",
      "ResourceType": "Invoice",
      "AzLocalRightName": "Update",
      "Constraints": {
        "Country": "Norway",
        "InvoiceAmount": 200
      }
    },
    {
      "ResourceID": "43e0e035-95d8-4c54-a4c4-4f3c0f37b57e",
      "ResourceType": "PurchaseOrder",
      "AzLocalRightName": "Read",
      "Constraints": {
        "Country": "Finland",
        "PurchaseOrderAmount": 100
      }
    },
    {
      "ResourceID": "00cabb75-868c-4061-bf17-f39a0132dccb",
      "ResourceType": "Document",
      "AzLocalRightName": "Read",
      "Constraints": {
        "Country": "Norway"
      }
    },
    {
      "ResourceID": "2e4dfb4c-f8b7-4c51-9ca3-74ea6488618d",
      "ResourceType": "Document",
      "AzLocalRightName": "Update",
      "Constraints": {
        "Country": "Sweden"
      }
    }
  ],
  "user2": [
    {
      "ResourceID": "*",
      "ResourceType": "Person",
      "AzLocalRightName": "Read",
      "Constraints": {
        "Country": ["Finland", "Denmark"]
      }
    },
    {
      "ResourceID": "b71f1f92-90eb-42c8-8a71-4969e9d2b2e8",
      "ResourceType": "Document",
      "AzLocalRightName": "Delete",
      "Constraints": {
        "Country": "Finland"
      }
    },
    {
      "ResourceID": "ae83b0a9-d925-4c4b-b2b4-3e3cde9813a1",
      "ResourceType": "Document",
      "AzLocalRightName": "Read",
      "Constraints": {
        "Country": "Norway"
      }
    }
  ]
}
```
This file includes a variety of assignments with constraints and a few where the '\*' is specified for the `ResourceID`.

user: Can I get it showing multiple applications as well

assistant: Certainly! Here's the updated `resourceaccesses.json` file that includes multiple applications:
```json
{
  "user1": {
    "myapp1": [
      {
        "ResourceID": "*",
        "ResourceType": "Invoice",
        "AzLocalRightName": "Read",
        "Constraints": {
          "Country": ["Norway", "Sweden"]
        }
      },
      {
        "ResourceID": "e56fa32c-9601-4c88-b9f9-02d66e0efbdb",
        "ResourceType": "Invoice",
        "AzLocalRightName": "Update",
        "Constraints": {
          "Country": "Norway",
          "InvoiceAmount": 200
        }
      },
      {
        "ResourceID": "43e0e035-95d8-4c54-a4c4-4f3c0f37b57e",
        "ResourceType": "PurchaseOrder",
        "AzLocalRightName": "Read",
        "Constraints": {
          "Country": "Finland",
          "PurchaseOrderAmount": 100
        }
      }
    ],
    "myapp2": [
      {
        "ResourceID": "00cabb75-868c-4061-bf17-f39a0132dccb",
        "ResourceType": "Document",
        "AzLocalRightName": "Read",
        "Constraints": {
          "Country": "Norway"
        }
      },
      {
        "ResourceID": "2e4dfb4c-f8b7-4c51-9ca3-74ea6488618d",
        "ResourceType": "Document",
        "AzLocalRightName": "Update",
        "Constraints": {
          "Country": "Sweden"
        }
      }
    ]
  },
  "user2": {
    "myapp1": [
      {
        "ResourceID": "*",
        "ResourceType": "Person",
        "AzLocalRightName": "Read",
        "Constraints": {
          "Country": ["Finland", "Denmark"]
        }
      },
      {
        "ResourceID": "b71f1f92-90eb-42c8-8a71-4969e9d2b2e8",
        "ResourceType": "Document",
        "AzLocalRightName": "Delete",
        "Constraints": {
          "Country": "Finland"
        }
      }
    ],
    "myapp2": [
      {
        "ResourceID": "ae83b0a9-d925-4c4b-b2b4-3e3cde9813a1",
        "ResourceType": "Document",
        "AzLocalRightName": "Read",
        "Constraints": {
          "Country": "Norway"
        }
      }
    ]
  }
}
```
This version of the `resourceaccesses.json` file now includes multiple applications (myapp1 and myapp2) for each user.
