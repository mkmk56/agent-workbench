Set sh = CreateObject("WScript.Shell")
Do
  code = sh.Run("""D:\Claude\agent-workbench\start-workbench.cmd""", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 5000
Loop