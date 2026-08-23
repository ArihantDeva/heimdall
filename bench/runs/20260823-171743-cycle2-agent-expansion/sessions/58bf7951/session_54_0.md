# session sharegpt_eyjhBv3_0 — 2023-05-29 (2023/05/29 (Mon) 22:10)

date: 2023/05/29 (Mon) 22:10
iso_date: 2023-05-29

user: how does the website connect to D365 or Navision? which part of the web site design is involved?

assistant: Connecting a website to Microsoft Dynamics 365 (D365) or Dynamics NAV (previously known as Navision) involves integrating the two systems to facilitate the exchange of data and business processes. This can be done using web services, APIs, or third-party connectors. The parts of the website design involved in this process are:

1. Backend development: The backend of your website needs to be designed to handle the integration with D365 or NAV. This involves writing server-side code that communicates with the Dynamics systems using web services, APIs, or connectors. The programming languages and frameworks used for backend development may include C#, ASP.NET, Node.js, or Python, among others.
2. APIs and Web Services: D365 and Dynamics NAV expose their functionality via web services, such as OData or SOAP, or RESTful APIs, allowing external systems to interact with them. You'll need to understand how to work with these APIs to query, create, update, or delete data in the Dynamics systems from your website. You might also need to authenticate your website's requests to these services using OAuth 2.0 or other security protocols.
3. Middleware or Integration Platform: In some cases, you may want to use a middleware or integration platform, such as Microsoft Power Automate (previously known as Microsoft Flow), Logic Apps, or third-party solutions like KingswaySoft, Scribe, or eOne SmartConnect. These tools help manage the connection between your website and Dynamics systems, handling data transformation, error handling, and logging. This can simplify the integration process and minimize the custom code you need to write.
4. Frontend development: The frontend or user interface of your website may also need to be designed to work with data from D
