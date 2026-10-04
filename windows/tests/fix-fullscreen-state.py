"""Shows, and with --fix removes, the fullscreen auto-disable record in Claude Code's state file.
Hidden test runs that were killed early counted as 'failed fullscreen starts' and tripped it."""
import json, os, shutil, sys, time

path = os.path.join(os.environ['USERPROFILE'], '.claude.json')
with open(path, encoding='utf-8') as f:
    state = json.load(f)

keys = [k for k in state if k.lower().startswith('fullscreen')]
for k in keys:
    print(k, '=', json.dumps(state[k])[:300])
if not keys:
    print('no fullscreen records in the state file')

if '--fix' in sys.argv and keys:
    backup = path + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
    shutil.copy2(path, backup)
    for k in keys:
        del state[k]
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=2)
    print('removed', keys, '- backup at', backup)
