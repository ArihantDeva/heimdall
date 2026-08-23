# session sharegpt_7gIKsqO_104 — 2023-02-15 (2023/02/15 (Wed) 11:14)

date: 2023/02/15 (Wed) 11:14
iso_date: 2023-02-15

user: I just need the JS file

assistant: Here it is:
```
const buttonList = document.querySelectorAll('input[type=button]');
const telInput = document.querySelector('input[type=tel]');
telInput.tabIndex = -1;
telInput.focus();

const addClass = (className) => (el) => el.classList.add(className);
const removeClass = (className) => (el) => el.classList.remove(className);
const setValue = (el, value) => (el.value += value);

const setupButtonEventListeners = (button) => {
  button.addEventListener("mousedown", addClass("ativa"));
  button.addEventListener("mouseup", removeClass("ativa"));
  button.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") addClass("ativa")(button);
  });
  button.addEventListener("keyup", removeClass("ativa"));
  button.addEventListener("click", () => setValue(telInput, button.value));
};

buttonList.forEach((button, index) => {
  button.tabIndex = index + 1;
  setupButtonEventListeners(button);
});

const firstButton = buttonList[0];
firstButton.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    telInput.focus();
  }
});

const setupInputEventListeners = (el) => {
  el.addEventListener("keydown", addClass("ativa"));
  el.addEventListener("keyup", removeClass("ativa"));
};
setupInputEventListeners(telInput);
```

user: Let's go back to the JS file from before. Here it is:

const buttonList = document.querySelectorAll('input[type=button]')
const telInput = document.querySelector('input[type=tel]')
telInput.tabIndex = -1
telInput.focus()

function setupButtonEventListeners(button) {
 const events = [
 {event: "mousedown", action: () => button.classList.add("ativa")},
 {event: "mouseup", action: () => button.classList.remove("ativa")},
 {event: "keydown", action: (e) => {
 if (e.key === " " || e.key === "Enter") button.classList.add("ativa")
 }},
 {event: "keyup", action: () => button.classList.remove("ativa")},
 {event: "click", action: () => telInput.value += button.value},
 ];

 events.forEach(({event, action}) => {
 button.addEventListener(event, action);
 });
}

for (let index = 0; index < buttonList.length; index++) {
 const button = buttonList[index]
 button.tabIndex = index + 1
 setupButtonEventListeners(button)
}

const firstButton = buttonList[0]
firstButton.addEventListener("keydown", e => {
 if (e.key === "Tab" && e.shiftKey) {
 e.preventDefault()
 telInput.focus()
 }
})

telInput.addEventListener("keydown", e => {
 if (e.key === " " || e.key === "Enter") telInput.classList.add("ativa")
});

telInput.addEventListener("keyup", () => telInput.classList.remove("ativa"))

How do I use a forEach method in the following lines?:

telInput.addEventListener("keydown", e => {
 if (e.key === " " || e.key === "Enter") telInput.classList.add("ativa")
});

telInput.addEventListener("keyup", () => telInput.classList.remove("ativa"))

assistant: You can use a forEach method by creating an array of objects that contains the event type and the action to be performed, then looping through the array and calling `addEventListener` for each event type and action.

Here is an example of how you can refactor the code to use a forEach method:
```
const telEvents = [
  {event: "keydown", action: e => {
    if (e.key === " " || e.key === "Enter") telInput.classList.add("ativa")
  }},
  {event: "keyup", action: () => telInput.classList.remove("ativa")},
];

telEvents.forEach(({event, action}) => {
    telInput.addEventListener(event, action);
});
```
You can see that I create an array called `telEvents` that contains two objects, one for each event listener. Then I use a forEach loop to go through each object in the array and add the event listener to the telInput element.

user: Wonderful! Here's the complete JS code as it stands:

const buttonList = document.querySelectorAll('input[type=button]')
const telInput = document.querySelector('input[type=tel]')
telInput.tabIndex = -1
telInput.focus()

function setupButtonEventListeners(button) {
 const events = [
 {event: "mousedown", action: () => button.classList.add("ativa")},
 {event: "mouseup", action: () => button.classList.remove("ativa")},
 {event: "keydown", action: (e) => {
 if (e.key === " " || e.key === "Enter") button.classList.add("ativa")
 }},
 {event: "keyup", action: () => button.classList.remove("ativa")},
 {event: "click", action: () => telInput.value += button.value},
 ];

 events.forEach(({event, action}) => {
 button.addEventListener(event, action);
 });
}

for (let index = 0; index < buttonList.length; index++) {
 const button = buttonList[index]
 button.tabIndex = index + 1
 setupButtonEventListeners(button)
}

const firstButton = buttonList[0]
firstButton.addEventListener("keydown", e => {
 if (e.key === "Tab" && e.shiftKey) {
 e.preventDefault()
 telInput.focus()
 }
})

const telEvents = [
 {event: "keydown", action: e => {
 if (e.key === " " || e.key === "Enter") telInput.classList.add("ativa")
 }},
 {event: "keyup", action: () => telInput.classList.remove("ativa")},
];

telEvents.forEach(({event, action}) => {
 telInput.addEventListener(event, action);
});

assistant: Yes, that is correct. You have used the forEach method to iterate through the `telEvents` array and attach the corresponding event and action to the `telInput` element. This makes the code more readable and maintainable.

user: So how can we further refactor the entire code to make it more readable?

assistant: One way to improve readability would be to extract the code that sets up the button event listeners into a separate function and then call that function for each button.
Another option would be to use a more descriptive variable name for the telEvents array, for example telInputEvents or telInputEventListeners.
You can also consider grouping the related events and actions together in a single object for each input, for example like this:
```
const telInput = {
  element: document.querySelector('input[type=tel]'),
  events: {
    keydown: e => {
      if (e.key === " " || e.key === "Enter") telInput.classList.add("ativa")
    },
    keyup: () => telInput.classList.remove("ativa"),
  }
};
```
This way it's more clear and easy to understand the relation between the input element and the events it listens to.

Another way could be creating a class for your phone input, which will help in modularizing and managing the code, also making it more readable and maintainable.

You can also use libraries to make the code more readable and maintainable.

Note that readability is a subjective concept and what works for one developer may not work for another. But these are some of the common ways to make the code more readable.

user: So what would the full code look like with this latest refactoring considered?

assistant: Here is one way the code could be refactored:
```
const buttonList = document.querySelectorAll('input[type=button]');
const telInput = document.querySelector('input[type=tel]');
telInput.tabIndex = -1;
telInput.focus();

const addEventListeners = (element, events) => {
    events.forEach(({event, action}) => {
        element.addEventListener(event, action);
    });
};

const buttonEvents = [
    {event: "mousedown", action: e => e.target.classList.add("ativa")},
    {event: "mouseup", action: e => e.target.classList.remove("ativa")},
    {event: "keydown", action: e => {
        if (e.key === " " || e.key === "Enter") e.target.classList.add("ativa")
    }},
    {event: "keyup", action: e => e.target.classList.remove("ativa")},
    {event: "click", action: e => telInput.value += e.target.value},
];

const telEvents = [
    {event: "keydown", action: e => {
        if (e.key === " " || e.key === "Enter") telInput.classList.add("ativa")
    }},
    {event: "keyup", action: e => telInput.classList.remove("ativa")},
];

buttonList.forEach((button, index) => {
    button.tabIndex = index + 1;
    addEventListeners(button, buttonEvents);
});

const firstButton = buttonList[0];
firstButton.addEventListener("keydown", e => {
    if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        telInput.focus();
    }
```
