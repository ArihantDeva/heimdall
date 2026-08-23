# session sharegpt_zq7r8FP_7 — 2023-05-23 (2023/05/23 (Tue) 15:40)

date: 2023/05/23 (Tue) 15:40
iso_date: 2023-05-23

assistant: When a booking is made on Expedia.com, you will need to update the property availability on other OTAs and your PMS. Here's how you can implement this process:

1. Receive the booking notification: Expedia.com will send a notification to your server when a booking is made. You will need to implement a webhook to receive this notification.
2. Retrieve the booking details: Extract the booking details from the notification, including the property ID, booking dates, and other relevant information.
3. Update the property availability on other OTAs: Use the worker pool approach described earlier to update the property availability on other OTAs. You will need to create a task for each OTA and add it to the worker queue. The task should include the OTA API endpoint for updating the property availability and the updated availability data.
4. Update the property availability in your PMS: Update the property availability in your PMS using your PMS API.

Here's an example code snippet of how you can implement the webhook to receive the booking notification and update the property availability:
```javascript
const express = require('express');
const async = require('async');
const request = require('request');

const app = express();
const PORT = 3000;

// Define the pool of workers
const workerPool = async.queue((task, callback) => {
  // Execute the API request for each task
  request.post(task.url, { json: task.body }, (err, response, body) => {
    if (err) {
      console.error(`Error executing API request for ${task.url}: ${err}`);
      callback(err);
    } else if (response.statusCode !== 200) {
      console.error(`Received ${response.statusCode} status code from ${task.url}`);
      callback(new Error(`Received ${response.statusCode} status code from ${task.url}`));
    } else {
      console.log(`API response from ${task.url}: ${JSON.stringify(body)}`);
      callback(null, body);
    }
  });
}, 2); // Set the concurrency limit to 2 workers

// Define the webhook to handle Expedia booking notifications
app.post('/expedia-booking-notification', (req, res) => {
  const bookingData = req.body;

  // Extract the booking details
  const propertyId = bookingData.propertyId;
  const startDate = bookingData.startDate;
  const endDate = bookingData.endDate;

  // Define the tasks for each OTA API endpoint
  const tasks = [
    { url: 'https://api.booking.com/v1/update-property-availability', body: { propertyId, startDate, endDate, availability: 'booked' } },
    { url: 'https://api.vrbo.com/v1/update-property-availability', body: { propertyId, startDate, endDate, availability: 'booked' } }
  ];

  // Add the tasks to the worker queue
  workerPool.push(tasks, (err, results) => {
    if (err) {
      console.error(`Error updating property availability: ${err}`);
    } else {
      console.log(`Updated property availability on ${results.length} OTAs`);
    }
  });

  // Update the property availability in your PMS
  // Your PMS API function for updating availability may vary
  updatePmsAvailability(propertyId, startDate, endDate, 'booked')
    .then(() => {
      console.log('Updated property availability in PMS');
      res.send({ success: true });
    })
    .catch((err) => {
      console.error(`Error updating property availability in PMS: ${err}`);
      res.status(500).send({ error: 'Error updating property availability in PMS' });
    });
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`
```

user: continue plaise

assistant: Sure, here's the continuation of the code snippet:
```javascript
// PMS API function for updating property availability
function updatePmsAvailability(propertyId, startDate, endDate, availability) {
  return new Promise((resolve, reject) => {
    // Make the API request to update the availability
    // Replace this with your actual PMS API function
    request.post('https://api.my-pms.com/v1/update-property-availability', {
      json: {
        propertyId,
        startDate,
        endDate,
        availability
      }
    }, (err, response, body) => {
      if (err) {
        reject(err);
      } else if (response.statusCode !== 200) {
        reject(new Error(`Received ${response.statusCode} status code from PMS API`));
      } else {
        resolve(body);
      }
    });
  });
}
```
Note that in the above example, the `updatePmsAvailability` function is a placeholder for the actual API function you will use to update the property availability in your PMS. You will need to replace this with your own implementation.

Also, the example assumes that you are using JSON as the payload format for your API requests. If your OTAs or PMS use a different payload format, you will need to adjust the code accordingly.

Finally, keep in mind that this is just a simplified example of how you can implement the booking update process. In a real-world scenario, you may need to add additional error handling and retry logic to handle any failures or timeouts.
