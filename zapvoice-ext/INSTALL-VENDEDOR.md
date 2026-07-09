# Sale Chat - Instalacao na maquina do vendedor

O Sale Chat aparece DENTRO do WhatsApp do PC (o app da Microsoft Store), como uma
barra lateral com os audios, mensagens, videos e funis prontos pra disparar com 1 clique.

## O que precisa ter (uma vez so)

1. **Windows 10/11**.
2. **WhatsApp do PC** instalado pela **Microsoft Store** e ja logado no numero do vendedor.
   - Se for usar o **WhatsApp Beta** tambem, instale ele pela Store (e um app separado).

Nao precisa instalar mais nada. O motor necessario e baixado sozinho na primeira vez.

## Como usar

1. Descompacte o arquivo `sale-chat-instalador.zip` numa pasta (ex: em `Documentos`).
2. Abra a pasta **Sale Chat** e de **dois cliques** em:
   - `start-normal.bat` -> pro **WhatsApp normal**
   - `start-beta.bat` -> pro **WhatsApp Beta**
3. Na primeira vez, ele baixa o motor sozinho (uns 30MB, so uma vez) e abre o WhatsApp.
   Se aparecer aviso do Windows, clique em **Mais informacoes -> Executar assim mesmo**.
4. Em poucos segundos o painel do Sale Chat aparece na **lateral direita** do WhatsApp.
5. Pronto: clique nos itens pra enviar no chat aberto. A setinha mostra a previa; o botao
   verde envia (e vira pausa pra cancelar).

## A janela que abre (importante)

Ao rodar, abre uma janelinha (ela se **minimiza sozinha**). **Nao feche** ela: deixe
minimizada. Enquanto ela roda:
- os **videos** conseguem ser enviados e pre-visualizados;
- se o WhatsApp reiniciar, o painel **volta sozinho**;
- as mudancas do funil entram **ao vivo**.

Se fechar a janela, os audios e mensagens que ja carregaram ainda funcionam, mas o video
e a reconexao automatica param. Entao: **minimize, nao feche.**

Dica: pra nao precisar clicar toda vez, de um clique-direito no `start-normal.bat` ->
**Enviar para -> Area de trabalho (criar atalho)**, e coloque esse atalho na pasta
**Inicializar** do Windows (tecla Windows + R, digite `shell:startup`, Enter, e cole o
atalho la). Assim ele sobe sozinho quando liga o PC.

## Usando os DOIS (normal + beta) ao mesmo tempo

Cada app usa uma porta propria, nao se cruzam (o fluxo do normal vai pro normal, o do beta
pro beta):

1. Abra o **start-normal.bat** primeiro e espere o painel aparecer no WhatsApp normal.
2. Depois abra o **start-beta.bat** e espere aparecer no Beta.
3. Deixe as **duas janelinhas** minimizadas (uma por app).

Se um dos WhatsApp reiniciar e o painel sumir so nele, e so rodar de novo o `.bat` daquele app.

## O funil / itens

Os audios, mensagens, videos e funis sao configurados na **dash** (pagina Sale Chat) e o
painel puxa automatico (atualiza ao vivo). Hoje o funil e central (o Diretor edita e todos
recebem). Se algo nao aparecer, confirme com o Diretor.
