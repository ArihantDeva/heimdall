# session sharegpt_SaUokxc_63 — 2023-05-25 (2023/05/25 (Thu) 03:35)

date: 2023/05/25 (Thu) 03:35
iso_date: 2023-05-25

assistant: Sure, here's an example of how you could modify the `ManageAPIAccessPage` component to include a big toggle that defines if the sync is on or off:
```jsx
import React, { useState, useEffect } from 'react';
import { getSquareIntegrationForBrand, updateSquareIntegration } from './api';

function ManageAPIAccessPage() {
  const [integration, setIntegration] = useState(null);
  const [squareApplicationId, setSquareApplicationId] = useState('');
  const [squareAccessToken, setSquareAccessToken] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(false);

  useEffect(() => {
    async function fetchData() {
      const integrationData = await getSquareIntegrationForBrand();
      setIntegration(integrationData);
      setSyncEnabled(integrationData && integrationData.syncEnabled);
    }
    fetchData();
  }, []);

  async function handleToggleSync() {
    const result = await updateSquareIntegration(integration._id, squareApplicationId, squareAccessToken, !syncEnabled);
    if (result.success) {
      setSyncEnabled(!syncEnabled);
    } else {
      console.error(`Failed to update Square integration: ${result.message}`);
    }
  }

  async function handleSaveIntegration() {
    const result = await updateSquareIntegration(integration._id, squareApplicationId, squareAccessToken, syncEnabled);
    if (result.success) {
      setIntegration(prevIntegration => ({ ...prevIntegration, applicationId: squareApplicationId, accessToken: squareAccessToken }));
    } else {
      console.error(`Failed to update Square integration: ${result.message}`);
    }
  }

  return (
    <div>
      <h1>Manage API Access</h1>
      {integration ? (
        <div>
          <h2>Square POS Integration</h2>
          <div>
            <label>
              Application ID:
              <input type="text" value={squareApplicationId} onChange={e => setSquareApplicationId(e.target.value)} />
            </label>
          </div>
          <div>
            <label>
              Access Token:
              <input type="text" value={squareAccessToken} onChange={e => setSquareAccessToken(e.target.value)} />
            </label>
          </div>
          <div>
            <label>
              Sync Enabled:
              <input type="checkbox" checked={syncEnabled} onChange={handleToggleSync} />
            </label>
          </div>
          <div>
            <button onClick={handleSaveIntegration}>Save Changes</button>
          </div>
        </div>
      ) : (
        <div>
          <h2>Add Square POS Integration</h2>
          <div>
            <label>
              Application ID:
              <input type="text" value={squareApplicationId} onChange={e => setSquareApplicationId(e.target.value)} />
            </label>
          </div>
          <div>
            <label>
              Access Token:
              <input type="text" value={squareAccessToken} onChange={e => setSquareAccessToken(e.target.value)} />
            </label>
          </div>
          <div>
            <button onClick={handleCreateIntegration}>Create Integration</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ManageAPIAccessPage;
```
In this modified `ManageAPIAccessPage` component, a big toggle is added to the Square POS integration section that allows the bar manager to enable or disable sync. When the user toggles the sync checkbox, the `handleToggleSync` function calls the `updateSquareIntegration` API endpoint to update the syncEnabled property of the Square integration. The checkbox is checked if syncEnabled is true, and unchecked if syncEnabled is false.

By adding

user: do you have to update the mongo schema or any other files with these changes?

assistant: Yes, if you want to store the `syncEnabled` property in the Square integration document in MongoDB, you would need to update the schema for the `SquareIntegration` model. You would also need to update any API endpoints that interact with the `SquareIntegration` document to include the `syncEnabled` property.

For example, if you want to update the `createSquareIntegration` and `updateSquareIntegration` API endpoints to include the `syncEnabled` property, you would need to update the `SquareIntegration` schema and the `createSquareIntegration` and `updateSquareIntegration` controller methods in the server-side code. You would also need to update any client-side code that interacts with these API endpoints to include the `syncEnabled` property in the request payload.

Additionally, if you want to display the `syncEnabled` property in the `ManageAPIAccessPage` component, you would need to update the client-side code to include the `syncEnabled` property in the `integration` state object and to render the toggle in the component's JSX.

user: Can you do that for me?

assistant: Sure! Here's an example of how you could modify the `SquareIntegration` schema and the `createSquareIntegration` and `updateSquareIntegration` controller methods to include the `syncEnabled` property:
```javascript
// models/SquareIntegration.js

const mongoose = require('mongoose');

const squareIntegrationSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
    unique: true,
  },
  applicationId: {
    type: String,
    required: true,
  },
  accessToken: {
    type: String,
    required: true,
  },
  syncEnabled: {
    type: Boolean,
    default: true,
  },
});

const SquareIntegration = mongoose.model('SquareIntegration', squareIntegrationSchema);

module.exports = SquareIntegration;
```

```javascript
// controllers/squareIntegrationController.js

const SquareIntegration = require('../models/SquareIntegration');

exports.createSquareIntegration = async (req, res) => {
  try {
    const squareIntegration = new SquareIntegration({
      brandId: req.user.brandId,
      applicationId: req.body.applicationId,
      accessToken: req.body.accessToken,
      syncEnabled: req.body.syncEnabled, // Add syncEnabled property to request body
    });
    await squareIntegration.save();
    res.json({
      success: true,
      message: 'Square integration created successfully',
      data: squareIntegration,
    });
  } catch (err) {
    res.json({
      success: false,
      message: 'Failed to create Square integration',
      error: err.message,
    });
  }
};

exports.updateSquareIntegration = async (req, res) => {
  try {
    const squareIntegration = await SquareIntegration.findOneAndUpdate(
      { brandId: req.user.brandId },
      {
        applicationId: req.body.applicationId,
        accessToken: req.body.accessToken,
        syncEnabled: req.body.syncEnabled, // Add syncEnabled property to request body
      },
      { new: true }
    );
    if (!squareIntegration) {
      return res.json({
        success: false,
        message: 'Square integration not found',
      });
    }
    res.json({
      success: true,
      message: 'Square integration updated successfully',
      data: squareIntegration,
    });
  } catch (err) {
    res.json({
      success: false,
      message: 'Failed to update Square integration',
      error: err.message,
    });
  }
};
```
In this example, the `SquareIntegration` schema is updated to include the `syncEnabled` property, which has a default value of `true`. The `createSquareIntegration` and `updateSquareIntegration` controller methods are modified to include the `syncEnabled` property in the request body.

You would also need to update any client-side code that interacts with these API endpoints to include the `syncEnabled` property in the request payload.

Finally, you would need to update the `ManageAPIAccessPage` component to include the `syncEnabled` property in the `integration` state object and to render the toggle in the component's JSX.

user: can you update the client-side code that you recommended? and can you also update the manageapiaccesspage too?

assistant: Sure, here's an example of how you could update the client-side code to include the `syncEnabled` property in the `SquareIntegration` object:
```javascript
// src/services/squareIntegrationService.js

import api from './api';

export const createSquareIntegration = async (integration) => {
  const { applicationId, accessToken, syncEnabled } = integration; // Destructure syncEnabled from integration object
  const response = await api.post('/square/integrations', {
    applicationId,
    accessToken,
    syncEnabled, // Add syncEnabled property to request body
  });
  return response.data;
};

export const updateSquareIntegration = async (integration) => {
  const { applicationId, accessToken, syncEnabled } = integration; // Destructure syncEnabled from integration object
  const response = await api.put('/square/integrations', {
    applicationId,
    accessToken,
    syncEnabled, // Add syncEnabled property to request body
  });
  return response.data;
};
```
And here's an example of how you could update the `ManageAPIAccessPage` component to include the `syncEnabled` property in the `integration` state object and to render the toggle in the component's JSX:
```javascript
// src/pages/ManageAPIAccessPage.js

import { useState, useEffect } from 'react';
import { getSquareIntegration, updateSquareIntegration } from '../services/squareIntegrationService';

const ManageAPIAccessPage = () => {
  const [integration, setIntegration] = useState({});

  const handleChange = (event) => {
    setIntegration({ ...integration, [event.target.name]: event.target.checked });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    await updateSquareIntegration(integration);
  };

  useEffect(() => {
    const fetchIntegration = async () => {
      const integration = await getSquareIntegration();
      setIntegration(integration);
    };
    fetchIntegration();
  }, []);

  return (
    <div>
      <h1>Manage API Access</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="syncEnabled">Sync Enabled:</label>
          <input
            type="checkbox"
            id="syncEnabled"
            name="syncEnabled"
            checked={integration.syncEnabled}
            onChange={handleChange}
          />
        </div>
        <button type="submit">Save Changes</button>
      </form>
    </div>
  );
};

export default ManageAPIAccessPage;
```
In this example, the `getSquareIntegration` function fetches the `syncEnabled` property from the Square integration document and includes it in the `integration` state object. The `handleChange` function updates the `syncEnabled` property in the `integration` state object when the user toggles the checkbox. The `handleSubmit` function sends an API request to update the Square integration document with the new `syncEnabled` value.

Finally, the `ManageAPIAccessPage` component includes a checkbox input that toggles the `syncEnabled` property in the `integration` state object and a `handleSubmit` function that updates the Square integration document with the new value.
