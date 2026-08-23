# session sharegpt_zvmX9pX_29 — 2023-05-26 (2023/05/26 (Fri) 08:43)

date: 2023/05/26 (Fri) 08:43
iso_date: 2023-05-26

assistant: | Concept | Description |
| --- | --- |
| Seeds | The Midjourney bot uses a seed number to create a field of visual noise, like television static, as a starting point to generate the initial image grids. Seed numbers are generated randomly for each image but can be specified with the --seed or --sameseed parameter. |
| --seed | Accepts whole numbers 0–4294967295. Only influences the initial image grid. Model Versions 1, 2, 3, test, and testp are non-deterministic and will produce similar, not identical, images. Using the same prompt+seed+parameters in Model Versions 4 and niji will produce identical images. |
| --sameseed | Accepts whole numbers 0–4294967295. Creates a single large random noise field applied across all images in the initial grid. Compatible with Model Versions 1, 2, 3, test, and testp. Produces very similar generated images. |
| Example | Jobs run three times with random seeds: prompt example: /imagine prompt celadon owl pitcher. An example of an image grid made in midjourney V4 with a random seed. Jobs run two times with --seed 123: prompt example: /imagine prompt celadon owl pitcher --seed 123. An example of an image grid made in midjourney V4 with a random seed. Jobs run three times with --seed 123 using Midjourney Model Version 3: prompt example: /imagine prompt celadon owl pitcher --seed 123 --v 3. Even with the same seed number, early Midjourney Model Versions are non-deterministic, so generated images will look different. |
| Finding a Job's Seed Number | Use a Discord Emoji Reaction: Find the seed number of a Job in discord by reacting with an ✉️ envelope emoji to a Job. Use The Show Command to Bring Back Old Jobs: To get the seed number for a past image, copy the job ID and use the /show <Job ID #> command with that ID to revive the Job. You can then react to the newly regenerated Job with an ✉️ envelope emoji. |
| Changing Seed Numbers | Use the --seed or --sameseed Parameter: Add --seed <value> or --sameseed <value> to the end of your prompt. Animated Gif showing how the Midjourney Seed parameter is typed. |

user: can you arrange the last content in a more easy to read way, in a table

assistant: Sure, here is a table that organizes the information provided in the previous content:

| Stop Percentage | Description | Example |
| --- | --- | --- |
| 10-100 | The --stop parameter can be used to finish a Job partway through the process. Lower values will result in blurrier, less detailed results. | /imagine prompt splatter art painting of acorns --stop 90 |
| N/A | The --stop parameter does not affect a Job while upscaling. However, stopping will produce a softer, less detailed initial image that will influence the level of detail in the final upscaled result. | N/A |
| 20 | Comparison of the initial grid image and the upscaled version of an image using stop 20 | --stop 20 |
| 80 | Comparison of the initial grid image and the upscaled version of an image using stop 80 | --stop 80 |
| 90 | Comparison of the initial grid image and the upscaled version of an image using stop 90 | --stop 90 |
| 100 | Comparison of the initial grid image and the upscaled version of an image using stop 100 | --stop 100 |

Note:

* The table is based on the information provided and I have rephrased it a bit for clarity.
* The last two rows of the table are examples of how the stop parameter affects the upscaling process.
* The Animated Gif showing how the Midjourney Stop parameter is typed could not be added to table format as it's not text but a visual representation.

user: another content to table: Stylize
 Light
This Midjourney Bot has been trained to produce images that favor artistic color, composition, and forms. The --stylize or --s parameter influences how strongly this training is applied. Low stylization values produce images that closely match the prompt but are less artistic. High stylization values create images that are very artistic but less connected to the prompt.
--stylize's default value is 100 and accepts integer values 0–1000 when using the default [V4 model].

Different Midjourney Version Models have different stylize ranges.

Version 4 Version 3 Test / Testp niji
Stylize default 100 2500 2500 NA
Stylize Range 0–1000 625–60000 1250–5000 NA
Common Stylize Settings
prompt example: /imagine prompt illustrated figs --s 100

--stylize 50
Midjourney style parameter example. Image of the prompt Vibrant California Poppies with style=50
🖌️ Style Low
--stylize 100 (default)
Midjourney stylize parameter example. Image of the prompt Vibrant California Poppies with style=100
🖌️ Style Med
--stylize 250
Midjourney stylize parameter example. Image of the prompt Vibrant California Poppies with style=250
🖌️ Style High
--stylize 750
Midjourney stylize parameter example. Image of the prompt Vibrant California Poppies with style=750
🖌️ Style Very High
How to Switch Stylization Values
Use the Stylize Parameter
Add --stylize  or --s  to the end of your prompt.

Animated Gif showing how to use the Midjourney style parameter.

Use the Settings Command
Type /settings and select your preferred stylize value from the menu.

🖌️ Style Low 🖌️ Style Med 🖌️ Style High 🖌️ Style Very High

assistant: | Parameter | Description | Default Value | Accepted Values |
| --- | --- | --- | --- |
| -- |  |  |  |
