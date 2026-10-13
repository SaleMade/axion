@echo off
rem Bot do grupo da SellWave: o WhatsApp Web do numero do bot, rodando neste PC.
rem Dois cliques e pronto. Fecha a janela pra parar. Pra rodar escondido ao ligar o PC, use bot-grupo-oculto.vbs
rem (a tarefa agendada "SellWave Bot do grupo" ja faz isso).
cd /d "%~dp0"
title SellWave Bot do grupo
node agente.mjs
echo.
echo O bot parou. Veja a mensagem acima.
pause
