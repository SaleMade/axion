# Sale Chat - Instalacao na maquina do vendedor

O Sale Chat aparece DENTRO do WhatsApp do PC (o app da Microsoft Store), como uma
barra lateral com os audios, mensagens, videos e funis prontos pra disparar com 1 clique.

## O que precisa ter (uma vez so)

1. **Windows 10/11**.
2. **WhatsApp do PC** instalado pela **Microsoft Store** e ja logado no numero do vendedor.
   - Se for usar o **WhatsApp Beta** tambem, instale ele pela Store (e um app separado).
3. **Node.js** (versao 21 ou mais nova): https://nodejs.org (baixe o "LTS", instale clicando avancar).
4. A **pasta do Sale Chat** (a pasta `zapvoice-ext`). Duas formas de pegar:
   - **Recomendado (atualiza sozinho):** instale o Git (https://git-scm.com), abra o Prompt e rode:
     `git clone <URL-DO-REPOSITORIO> Sale-Made` e use a pasta `Sale-Made/AXION/zapvoice-ext`.
   - **Simples:** o Diretor te manda a pasta `zapvoice-ext` zipada; descompacte em algum lugar
     (ex: `C:\SaleChat`). (Sem Git, a atualizacao automatica nao roda; peca a pasta nova quando tiver update.)

## Como usar no dia a dia

1. Abra o **WhatsApp do PC** e deixe logado.
2. Entre na pasta `zapvoice-ext` e de **dois cliques** em:
   - `start-normal.bat` -> pro **WhatsApp normal**
   - `start-beta.bat` -> pro **WhatsApp Beta**
   - (`start.bat` faz o mesmo que o normal.)
3. Vai abrir uma **janela preta** (deixe ela aberta). Em poucos segundos o painel do Sale
   Chat aparece na **lateral direita** do WhatsApp.
4. Pronto: clique nos itens pra enviar no chat que estiver aberto. A setinha mostra a previa
   antes de mandar; o botao verde envia (e vira pausa pra cancelar).

Pra **fechar**: feche a janela preta.

## Usando os DOIS (normal + beta) ao mesmo tempo

Cada app usa uma porta propria pra nao se cruzarem (o fluxo do normal vai pro normal, o do
beta vai pro beta):

1. Abra o **start-normal.bat** primeiro e espere o painel aparecer no WhatsApp normal.
2. Depois abra o **start-beta.bat** e espere aparecer no Beta.
3. Deixe as **duas janelas pretas** abertas (uma por app).

Obs: se um dos WhatsApp reiniciar sozinho e o painel sumir so nele, e so rodar de novo o
`.bat` daquele app.

## Atualizacoes

- Se voce pegou por **git clone**, cada vez que roda o `.bat` ele **puxa a versao mais nova
  sozinho**. Nao precisa reinstalar.
- Se voce nao mudou nada na dash, as edicoes do funil entram **ao vivo** (o painel se atualiza
  sozinho a cada ~20s). So precisa rodar o `.bat` de novo quando sair uma **versao nova do painel**.

## O funil / itens

Os audios, mensagens, videos e funis sao configurados na **dash** (pagina Sale Chat) e o
painel puxa automatico (atualiza ao vivo). Hoje o funil e **central** (o Diretor edita e todos
recebem o mesmo). Se algo nao aparecer, confirme com o Diretor.

> Em breve: area por vendedor, pra cada um ajustar o proprio funil sem mexer no dos outros.
