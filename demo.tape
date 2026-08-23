Output assets/demo.gif
Set Shell "bash"
Set FontSize 22
Set Width 1100
Set Height 520
Set Theme "Dracula"

Type "heimdall doctor"
Enter
Sleep 4s

Type "heimdall search 'portfolio optimization' -n 3"
Enter
Sleep 8s

Type "heimdall search 'excel tracker portfolio' -n 3"
Enter
Sleep 8s

Type "heimdall insert --title 'jam_opt EV optimizer' --body '~/Repos/poker-bot/tools -- heads-up jam/fold EV optimizer' --keywords poker,optimize"
Enter
Sleep 5s

Type "heimdall search 'jam EV optimizer' -n 3"
Enter
Sleep 8s

Type "heimdall verify --deep"
Enter
Sleep 4s
