' Roda o bot do grupo sem janela (usado pela tarefa agendada "SellWave Bot do grupo", ao entrar no Windows).
' A saida vai pra bot-grupo.log, na mesma pasta.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
sh.Run "cmd /c node agente.mjs >> ""bot-grupo.log"" 2>&1", 0, False
