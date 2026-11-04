# PUBLICA A VERSAO DE MAC DO SELLWAVE WEB (04/11/2026). Roda no PC do Bruno, do Git Bash:
#
#   python publica-mac.py                 # dispara o build no Mac do GitHub, espera, publica
#   python publica-mac.py <run_id>        # publica um build que ja rodou (tem que ter dado certo)
#   python publica-mac.py <run_id> --notas "o que mudou, pro cobrador ler"
#
# O que faz, em ordem, e por que:
#   1. o build (.github/workflows/sellwave-web-mac.yml) tem que ser do MESMO commit que esta no
#      git local: publicar outro seria o "codigo velho na tela de quem achava que era o atual".
#      Ele tambem tem que ter passado no autoteste do app empacotado, la no Mac.
#   2. baixa o .dmg do artefato e sobe pro R2 (salechat-media/sellwave-web/instalador-mac.dmg),
#      que o worker serve em /api/swweb/instalador-mac;
#   3. confere que o servido tem o MESMO sha256 do baixado;
#   4. carimba a versao no feed de Mac (POST /api/swweb/app com so:'mac'), com uma sessao de
#      diretor temporaria que e apagada no fim. So depois do arquivo no ar: o carimbo e o que faz o
#      app de Mac avisar "versao nova" e a tela da dash mostrar o botao.
#
# O token do GitHub vem do gerenciador de credenciais do git (o mesmo do push) e nunca e impresso.
# Nenhum token da Cloudflare vai pro GitHub: a subida pro R2 e daqui.
import hashlib, io, json, os, secrets, subprocess, sys, tempfile, time, urllib.request, zipfile

AQUI = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(AQUI, '..', 'backend')
REPO = 'SaleMade/axion'
WF = 'sellwave-web-mac.yml'
API = 'https://axion-api.axion-dash.workers.dev'
ENV = dict(os.environ, CLOUDFLARE_ACCOUNT_ID='b093e977b0ea6c9c022526dc02ca6d78')
DIRETOR = 'socio_x4dy6d'   # Bruno Correa (o carimbo sai no nome dele)


def token_github():
    r = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True)
    for linha in r.stdout.splitlines():
        if linha.startswith('password='):
            return linha[len('password='):]
    raise SystemExit('PAREI: sem credencial do GitHub no git deste PC')


TOK = token_github()


# O DOWNLOAD DO ARTEFATO NAO PODE LEVAR O TOKEN DO GITHUB (04/11/2026). O /artifacts/<id>/zip
# responde um 302 pro Azure com a URL JA ASSINADA; o urllib reenvia o cabecalho Authorization no
# salto e o Azure devolve "401 Server failed to authenticate the request". O build tinha dado certo
# e a publicacao morria no ultimo passo. Aqui o cabecalho cai no redirecionamento.
class _SemAuthNoSalto(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        novo = super().redirect_request(req, fp, code, msg, headers, newurl)
        if novo is not None:
            novo.remove_header('Authorization')
        return novo


_ABRE = urllib.request.build_opener(_SemAuthNoSalto)


def gh(caminho, metodo='GET', corpo=None, cru=False):
    req = urllib.request.Request('https://api.github.com' + caminho, method=metodo,
                                 data=json.dumps(corpo).encode() if corpo is not None else None,
                                 headers={'Authorization': 'Bearer ' + TOK, 'Accept': 'application/vnd.github+json', 'User-Agent': 'publica-mac'})
    with _ABRE.open(req, timeout=300) as r:
        b = r.read()
        return b if cru else (json.loads(b) if b else None)


def d1(sql):
    r = subprocess.run('npx wrangler d1 execute axion --remote --json --command "' + sql.replace('"', '\\"') + '"',
                       cwd=BACKEND, env=ENV, capture_output=True, shell=True)
    return json.loads(r.stdout.decode('utf-8'))[0]['results']


args = [a for a in sys.argv[1:]]
notas = ''
if '--notas' in args:
    i = args.index('--notas'); notas = args[i + 1]; del args[i:i + 2]
# --zip <arquivo>: o artefato daquele build ja baixado (sao ~230 MB; baixar de novo leva minutos)
zip_local = ''
if '--zip' in args:
    i = args.index('--zip'); zip_local = args[i + 1]; del args[i:i + 2]
head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=AQUI, capture_output=True, text=True).stdout.strip()

if args:
    run_id = int(args[0])
else:
    antes = gh('/repos/%s/actions/workflows/%s/runs?per_page=1' % (REPO, WF))['workflow_runs']
    ultimo = antes[0]['id'] if antes else 0
    gh('/repos/%s/actions/workflows/%s/dispatches' % (REPO, WF), 'POST', {'ref': 'main'})
    print('build disparado no Mac do GitHub; esperando ele aparecer...')
    run_id = 0
    for _ in range(30):
        time.sleep(4)
        l = gh('/repos/%s/actions/workflows/%s/runs?per_page=1' % (REPO, WF))['workflow_runs']
        if l and l[0]['id'] != ultimo:
            run_id = l[0]['id']; break
    if not run_id:
        raise SystemExit('PAREI: o build nao apareceu')

print('build', run_id)
while True:
    run = gh('/repos/%s/actions/runs/%d' % (REPO, run_id))
    if run['status'] == 'completed':
        break
    time.sleep(20)
if run['conclusion'] != 'success':
    raise SystemExit('PAREI: o build terminou com ' + str(run['conclusion']) + ': ' + run['html_url'])
if run['head_sha'] != head:
    # Outra conversa pode ter commitado no worker depois do build: o que importa e o app ser o mesmo.
    # So o que vai no pacote: src, package.json, package-lock.json e build/ (icone). Doc e este
    # script mudarem depois nao muda o app.
    igual = subprocess.run(['git', 'diff', '--quiet', run['head_sha'], head, '--', 'src', 'package.json', 'package-lock.json', 'build'], cwd=AQUI).returncode == 0
    if not igual:
        raise SystemExit('PAREI: o build e do commit %s e o app mudou depois dele (git local em %s)' % (run['head_sha'][:7], head[:7]))

arts = gh('/repos/%s/actions/runs/%d/artifacts' % (REPO, run_id))['artifacts']
art = [a for a in arts if a['name'] == 'sellwave-web-mac']
if not art:
    raise SystemExit('PAREI: o build nao tem o artefato sellwave-web-mac')
if zip_local:
    # o tamanho tem que bater com o artefato DESTE build: zip de outro build nao passa
    if os.path.getsize(zip_local) != art[0]['size_in_bytes']:
        raise SystemExit('PAREI: o --zip tem %d bytes e o artefato do build %d tem %d' % (os.path.getsize(zip_local), run_id, art[0]['size_in_bytes']))
    z = zipfile.ZipFile(zip_local)
else:
    z = zipfile.ZipFile(io.BytesIO(gh('/repos/%s/actions/artifacts/%d/zip' % (REPO, art[0]['id']), cru=True)))
dmgs = [n for n in z.namelist() if n.endswith('.dmg')]
if len(dmgs) != 1:
    raise SystemExit('PAREI: esperava 1 .dmg no artefato e veio ' + str(dmgs))
dmg = z.read(dmgs[0])
versao = dmgs[0].split('SellWave-Web-')[-1].split('-mac.dmg')[0]
print('dmg', dmgs[0], len(dmg), 'bytes, versao', versao)
sha = hashlib.sha256(dmg).hexdigest()
pasta = tempfile.mkdtemp(prefix='sw-mac-')
arq = os.path.join(pasta, 'instalador-mac.dmg')
open(arq, 'wb').write(dmg)

r = subprocess.run(['npx', 'wrangler', 'r2', 'object', 'put', 'salechat-media/sellwave-web/instalador-mac.dmg',
                    '--file', arq, '--content-type', 'application/x-apple-diskimage', '--remote'],
                   cwd=BACKEND, env=ENV, capture_output=True, shell=(os.name == 'nt'))
if r.returncode != 0:
    raise SystemExit('PAREI: o R2 recusou: ' + (r.stderr or r.stdout).decode('utf-8', 'replace')[-400:])

with urllib.request.urlopen(urllib.request.Request(API + '/api/swweb/instalador-mac?v=' + secrets.token_hex(4), headers={'User-Agent': 'publica-mac'}), timeout=300) as resp:
    servido = resp.read()
if hashlib.sha256(servido).hexdigest() != sha:
    raise SystemExit('PAREI: o .dmg servido (%d bytes) nao e o que subiu (%d bytes)' % (len(servido), len(dmg)))
print('no ar e igual ao baixado: sha256', sha[:16])

tok = secrets.token_hex(32)
d1("INSERT INTO sessions (token,user_id,expires_at) VALUES ('%s','%s',%d)" % (tok, DIRETOR, int(time.time()) + 600))
try:
    corpo = {'versao': versao, 'bytes': len(dmg), 'notas': notas, 'so': 'mac'}
    req = urllib.request.Request(API + '/api/swweb/app', data=json.dumps(corpo).encode(), method='POST',
                                 headers={'Authorization': 'Bearer ' + tok, 'content-type': 'application/json', 'User-Agent': 'Mozilla/5.0 publica-mac'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        print('carimbo:', resp.status, resp.read().decode()[:200])
finally:
    d1("DELETE FROM sessions WHERE token='%s'" % tok)
    print('sessao temporaria apagada:', d1("SELECT COUNT(*) n FROM sessions WHERE token='%s'" % tok))
# Com User-Agent: o Cloudflare recusa (403) o "Python-urllib" puro.
with urllib.request.urlopen(urllib.request.Request(API + '/api/swweb/versao?so=mac&v=' + secrets.token_hex(4), headers={'User-Agent': 'publica-mac'}), timeout=30) as resp:
    print('feed de Mac:', resp.read().decode())
os.remove(arq)
