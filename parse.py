import json
import sys
import argparse
import re
import os
import io

# Language codes used by the translation web app, mapped to Localize.xls columns.
TL_META_LANGS = [
  ("en", "English"),
  ("zh-hans", "ChineseSimplified"),
  ("zh-hant", "ChineseTraditional"),
]

# Bumped when the meaning of a data-* attribute changes, so the app can tell.
TL_META_VERSION = 3

def escapeAttr(s):
  return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")

def dumpJson(filename, obj, **kwargs):
  with open(filename, "w", encoding="utf-8") as f:
    json.dump(obj, f, ensure_ascii=False, indent="", **kwargs)

def parseJson(filename):
  with open(filename, "r", encoding="utf-8") as f:
    return json.load(f)

# This method will change the same |filename| into new format
def processBookJson(filename):
  obj = parseJson(filename)

  if type(obj) == list:
    result = adaptor(obj)
    dumpJson(filename, result)
    return result

  if "importGridList" not in obj:
    return obj

  result = {}
  for scenario in obj["importGridList"]:
    S = []
    for row in scenario["rows"]:
      S.append(row["strings"])
    header = S[0]
    x = []
    HL = len(header)
    for s in S[1:]:
      o = {}
      for i in range(min(len(s), HL)):
        a = s[i]
        if a != "":
          o[header[i]] = a
      x.append(o)

    result[scenario["name"]] = x

  dumpJson(filename, result)
  return result

def adaptor(chapters):
  obj = {}

  try:
    for C in chapters:
      name = C["name"]
      S = C["scenario"]
      header = S[0]
      x = []
      HL = len(header)
      for s in S[1:]:
        o = {}
        for i in range(min(len(s), HL)):
          a = s[i]
          if a != "":
            o[header[i]] = a
        x.append(o)
      obj[name] = x
  except:
    print(header, o, s, i)
    raise

  return obj

class Html:
  HEADER = '''<!DOCTYPE html><html>
<meta content="text/html;charset=utf-8" http-equiv="Content-Type">
<meta content="utf-8" http-equiv="encoding">
<style>
h3 {
  top: 0;
  position: sticky;
  background: #7986CB;
  padding: 5px;
}
.select {
  background: #8888ff;
}
.select a {
  color: #fff !important;
}
.jump {
  background: #88ff88;
}
.label {
  background: #ffff88;
}
.label:target {
  background: #ff8888;
}
.chara {
  font-weight: 900;
}
.text {
  background: #f5f5f5;
}
.title {
  background: #88ffff;
}
.voice {
  color: #7f7f7f;
}
.select, .jump, .label, .text, textarea, .title {
  margin: 10px;
  padding: 10px;
}
.cond-block {
  margin-inline-start: 2px;
  margin-inline-end: 2px;
  padding-block-start: 0.35em;
  padding-inline-start: 0.75em;
  padding-inline-end: 0.75em;
  padding-block-end: 0.625em;
  min-inline-size: min-content;
  border: 2px groove threedface;
}
.cond {
  padding-inline-start: 2px;
  padding-inline-end: 2px;
  border-width: initial;
  border-style: none;
  border-color: initial;
  border-image: initial;
}
.effect {
  padding: 5px;
  line-height: 2;
  white-space: nowrap;
  border-radius: 5px;
  background: #888888;
  color: #fff;
}
em {
  text-emphasis: circle;
  -webkit-text-emphasis: circle;
  font-style: normal;
}
.hide-br br {
  display: none;
}
.hide-ruby rt {
  display: none;
}
.hide-ruby ruby {
  // text-shadow: 0 0 8px #ee00ee;
  background: #ffaaff;
}
.control {
  position: fixed;
  top: 15px;
  right: 10px;
  background: #fff;
}
</style>
<body>
<fieldset class="control">
<legend>Control</legend>
<input type="checkbox" id="br-btn"><label>Hide line break</label>
<input type="checkbox" id="ruby-btn"><label>Hide ruby text</label>
</fieldset>
<ol>
'''

  FOOTER = '''
<script>
document.querySelector("#br-btn").onclick = function() {
  document.body.classList.toggle("hide-br");
};
document.querySelector("#ruby-btn").onclick = function() {
  document.body.classList.toggle("hide-ruby");
};
</script></body></html>
'''

  VALEN_PATTERN = re.compile(r'valen\w+special(_main)?\.book')

  def __init__(self, filename, args):
    self.filename = filename
    self.effecton = args.effecton
    self.lang = args.lang
    self.no_newline = args.no_newline
    self.skip = args.skip

    self.valen_special = args.valentine or self.VALEN_PATTERN.match(self.filename) != None

    self.tl_name = args.common and (args.special or args.tl_name)

    # Machine-readable annotations for the translation web app. Purely additive --
    # they are attributes on the elements that were already being written, so
    # anything that reads the visible HTML is unaffected.
    self.tl_meta = args.tl_meta and bool(args.common) and os.path.exists(args.common)
    if args.tl_meta and not self.tl_meta:
      print(f"warning: {args.common} not found, writing HTML without translation metadata")

    # Deduplicated character metadata: assigned once per distinct Arg1 sprite id,
    # referenced by every line via data-chara-id instead of repeating the same
    # official names inline on every line that character speaks.
    self.chara_ids = {}
    self.chara_meta = {}

    if self.tl_name or self.tl_meta:
      self.process_common(args.common)

  def write(self, s):
    self.f.write(s + '\n')

  def dumpHtml(self):
    with open(self.filename + self.lang["suffix"], 'w', encoding='utf-8') as f:
      self.f = f
      self.dumpHtmlImpl()

  def dumpHtml2Array(self):
    with io.StringIO() as f:
      self.f = f
      self.dumpHtmlImpl()
      return f.getvalue().split("\n")

  def writeValenSpecialList(self, name, scenario):
    min_underscore = self.countMinLabelUnderscore(name, scenario)

    self.write('<ol>')
    for c in scenario:
      command = c.get("Command", "")
      if not command.startswith('*'): continue

      hash = self.processHash(command, "")
      if hash.count("_") == min_underscore:
        self.write(f'<li><a href="#{hash}">{hash}</a></li>')

    self.write('</ol>')

  def countMinLabelUnderscore(self, name, scenario):
    if not scenario[0].get("Command", "").startswith('*'):
      scenario.insert(0, {"Command": "*" + name})

    ans = 10
    for c in scenario:
      command = c.get("Command", "")
      if not command.startswith('*'): continue

      hash = self.processHash(command, "")
      ans = min(ans, hash.count("_"))
    return ans

  def dumpHtmlImpl(self):
    header = self.HEADER
    if self.tl_meta:
      book = os.path.basename(self.filename)
      header = header.replace('<body>', f'<body data-parse-version="{TL_META_VERSION}"'
                                        f' data-book="{escapeAttr(book)}">')
    self.write(header)

    for k in self.chapters:
      name = self.getName(k)
      words = self.countJpWords(self.chapters[k])
      self.write(f'<li><a href="#{name}">{name}</a> (~ {words} jp words)</li>')

    self.write('</ol>')

    skip = self.skip
    for k in self.chapters:
      if skip > 0:
        skip -= 1
      else:
        self.dumpScenario(self.getName(k), self.chapters[k])

    if self.tl_meta and self.chara_meta:
      self.write(f'<script type="application/json" id="chara-meta">'
                 f'{json.dumps(self.chara_meta, ensure_ascii=False)}</script>')
    self.write(self.FOOTER)

  def getName(self, s):
    ss = s.split(":")
    return ss[0] if len(ss) == 1 else ss[1]

  def ignore(self, c):
    self.write('<!-- ' + repr(c) + '-->')

  def dumpScenario(self, name, scenario):
    words = f' data-jp-words="{self.countJpWords(scenario)}"' if self.tl_meta else ''
    self.write(f'<h3 id="{name}"{words}>{name}</h3>')

    if self.valen_special:
      self.writeValenSpecialList(name, scenario)

    dialogue = self.lang["dialogue"]
    if_block = False

    for c in scenario:
      command = c.get("Command", "")
      if command.startswith('*'):
        hash = self.processHash(command, name)
        self.write(f'<div class="label" id="{hash}">Label: {hash}</div>')
      elif command == '' or command == 'Character' or command == 'ShadowMaskCharacter':
        self.processLine(c, dialogue)
      elif command == 'TitleImage':
        episode = c["Arg1"]
        title = c["Arg2"]
        self.write(f'<div class="title">{episode} - {title}</div>')
      elif command == 'Jump':
        hash = self.processHash(c["Arg1"], name)
        extra = ''
        if "Arg2" in c: extra = ('(' + c["Arg2"] + ')')
        meta = self.metaAttrs([("to", hash), ("if", c.get("Arg2"))]) if self.tl_meta else ''
        self.write(f'<div class="jump"{meta}>Jump to <a href="#{hash}">{hash}</a> {extra}</div>')
      elif command == 'JumpRandom':
        hash = self.processHash(c["Arg1"], name)
        extra = ''
        if "Arg2" in c: extra = ('(' + c["Arg2"] + ')')
        meta = self.metaAttrs([("to", hash), ("if", c.get("Arg2")), ("random", "1")]) if self.tl_meta else ''
        self.write(f'<div class="jump"{meta}>50% chance of jumping to <a href="#{hash}">{hash}</a> {extra}</div>')
      elif command == 'Param':
        self.write(f'<p>Set {c["Arg1"]}</p>')
      elif command == 'Bg':
        self.write(f'<p>Background: {c["Arg1"]}</p>')
      elif command == 'Bgm':
        self.write(f'<p>BGM: {c["Arg1"]}</p>')

      # Assume no nested ifs
      elif command == 'If':
        cond = c.get('Arg1', '')
        if cond.find("team") != -1 or cond.find("player") != -1:
          if_block = True
          self.write(f'<div class="cond-block"><div class="cond"><code>If {cond}</code></div>')
      elif command == 'ElseIf' and if_block:
        self.write(f'</div><div class="cond-block"><div class="cond"><code>ElseIf {c.get("Arg1", "")}</code></div>')
      elif command == 'Else' and if_block:
        self.write(f'</div><div class="cond-block"><div class="cond"><code>Else</code></div>')
      elif command == 'EndIf' and if_block:
        if_block = False
        self.write('</div>')

      elif command == 'Selection':
        hash = self.processHash(c["Arg1"], name)
        line = self.escapeLine(c.get(dialogue, ""))
        arg2 = c.get("Arg2", None)
        arg3 = c.get("Arg3", None)
        if self.tl_meta:
          # Keep the condition out of the anchor text, so what gets translated is
          # the option the player reads and nothing else.
          meta = self.metaAttrs([("to", hash), ("if", arg2), ("do", arg3)])
        else:
          meta = ''
          if arg2:
            line += f" (If {arg2})"
          if arg3:
            line += f" (Execute {arg3})"
        self.write(f'<div class="select"{meta}><a href="#{hash}">{line}</a></div>')
      elif self.effecton:
        self.processEffects(c)

  def processEffects(self, c):
    self.ignore(c)

  def processHash(self, s, name):
    if s != '*end':
      return s[1:]
    return name + '-end'

  RUBY_PATTERN = re.compile(r'<ruby=(.*?)>(.*?)</ruby>')
  PARAM_PATTERN = re.compile(r'<param=(.*?)>')
  EM_PATTERN = re.compile(r'em=.>')
  SIZE_LEFT_PATTERN = re.compile(r'<size=(.*?)>')

  def processLine(self, c, dialogue):
    if "Arg1" not in c and dialogue not in c: return

    arg1 = c.get("Arg1", "")
    s = '<div class="text"' + self.lineMeta(c, arg1) + '>'

    if self.tl_name and arg1 != '':
      s += f'<span class="chara">{self.getTranslated(self.getCharacter(arg1))}:</span> '
    elif arg1 != '':
      s += '<span class="chara">' + arg1
      arg2 = c.get("Arg2", "")
      if arg2 != '':
        if arg2 == '<Off>': s += ' (hide sprite)'
        else: s += ' (' + arg2 + ')'
      s += ':</span> '

    if dialogue in c: s += self.escapeLine(c[dialogue])
    elif "Text" in c: s += self.escapeLine(c["Text"])

    if "Voice" in c:
      s += ' <span class="voice notranslate">(' + c["Voice"] + ')</span>'

    s += '</div>'
    if self.no_newline: s = s.replace('<br>', ' ')
    self.write(s)

  def lineMeta(self, c, arg1):
    if not self.tl_meta or arg1 == '': return ''

    arg2 = c.get("Arg2", "")
    pose = 'hide sprite' if arg2 == '<Off>' else arg2
    pairs = [("chara-id", self.charaId(arg1)), ("pose", pose)]
    return self.metaAttrs(pairs)

  def escapeLine(self, s, size_left_replace=r'<span style="font-size: calc(\1px * 0.5)">', size_right_replace="</span>"):
    s = self.RUBY_PATTERN.sub(r'<ruby>\2<rp>(</rp><rt>\1</rt><rp>)</rp></ruby>', s)
    param_replace = (r'<code data-param="\1">&lt;param=\1&gt;</code>' if self.tl_meta
                     else r'<code>&lt;param=\1&gt;</code>')
    s = self.PARAM_PATTERN.sub(param_replace, s)
    s = self.EM_PATTERN.sub(r'em>', s)
    s = self.SIZE_LEFT_PATTERN.sub(size_left_replace, s)
    return self.tidyHtml(s.replace('\n', '<br>').replace('</size>', size_right_replace))

  def tidyHtml(self, s):
    s += '</font>' * max(0, s.count('<font') - s.count('</font>'))
    s += '</em>' * max(0, s.count('<em') - s.count('</em>'))
    s += '</ruby>' * max(0, s.count('<ruby') - s.count('</ruby>'))
    return s

  TAG_PATTERN = re.compile(r'<(.*?)>')

  def countJpWords(self, scenario):
    dialogue = "Text"
    total = 0
    # S = set()

    for c in scenario:
      command = c.get("Command", "")
      if command == '' or command == 'Selection':
        line = c.get(dialogue, "")
        total += len(line)
        for m in self.TAG_PATTERN.finditer(line):
          # S.add(m.groups()[0])
          ml = m.end() - m.start()
          total -= ml
          tag = m.groups()[0]
          if tag.startswith("param"):
            total += 1
          elif tag.startswith("ruby"):
            total += ml - 7 # <ruby=>

    return total

  def process_greeting(self, filename):
    dialogue = self.lang["dialogue"]

    result = {}
    for name in self.chapters:
      r = self.getName(name)[len("greeting_"):]
      scenario = self.chapters[name]

      lines = {}
      for c in scenario:
        voice = c.get("Voice", ' ')[:-1] # remove the ending number
        if voice != '':
          voicePart = c.get("Voice", ' ')[-1]
          if voicePart in ('3', '4'):
              voice += "_another"
          result.setdefault(voice, []).append(
            self.escapeLine(c.get(dialogue, ""), size_left_replace='<strong>', size_right_replace='</strong>'))

    joined = {}
    for k in result:
      s = "<br>".join(result[k])
      if s != "<br>":
        joined[k] = s

    dumpJson(filename, joined, sort_keys=True)

  def process_sign(self) -> dict:
    """
    Return a mapping of
    quest label → formatted dialogue string for the given language.

    Content format:
        {text}\\n{text}\\n...\\n\\n*Signing noise*\\n\\n{text}...

    Returns:
        {"quest_sign_akashi_1": "...", "quest_sign_akashi_2": "...", ...}
    """
    dialogue_key = self.lang["dialogue"]
    sign_break = self.lang["sign_break"]
    result = {}

    for scenario in self.chapters.values():
      # Derive quest label from the first *-prefixed Command row
      quest_label = None
      for c in scenario:
        cmd = c.get("Command", "")
        if cmd.startswith("*"):
          quest_label = cmd[1:]   # e.g. "quest_sign_akashi_1"
          break
      if quest_label is None:
        continue

      before: list[str] = []
      after:  list[str] = []
      past_sign = False

      for c in scenario:
        cmd = c.get("Command", "")

        # Signing-noise marker: Se command with se_signature* sound
        if cmd == "Se" and c.get("Arg1", "").startswith("se_signature"):
          past_sign = True
          continue

        # Dialogue row: no Command, or explicit character commands
        if cmd in ("", "Character", "ShadowMaskCharacter"):
          raw = c.get(dialogue_key)
          if raw:
            text = self.escapeLine(raw)
            (after if past_sign else before).append(text)

      if len(before) + len(after) == 0:
        continue

      content = "<br><br>".join(filter(None, [
        "<br><br>".join(before),
        f'<i>{sign_break}</i>',
        "<br><br>".join(after),
      ]))

      result[quest_label] = content

    return result

  def process_common(self, filename):
    obj = parseJson(filename)
    self.translated = make_map(obj, self.lang)
    self.character = make_map2(obj)
    # Every localized column at once, so one HTML file serves every target language.
    self.translated_all = {
      code: make_map(obj, {"name": column}) for code, column in TL_META_LANGS
    }

  def getTranslated(self, key):
    return self.translated.get(key, key)

  def getCharacter(self, key):
    return self.character.get(key, key)

  def officialNames(self, arg1):
    """Official name per language for a sprite id, via Character.xls then Localize.xls.

    Returns only the languages that actually have a translation; a name that is
    merely echoed back untranslated tells the model nothing it did not already know.
    """
    display = self.getCharacter(arg1)
    out = {}
    for code, _ in TL_META_LANGS:
      value = self.translated_all[code].get(display)
      if value and value != display:
        out[code] = value
    return out

  def charaId(self, arg1):
    """Assign (and cache) a short id for a sprite id, recording its metadata once."""
    if arg1 not in self.chara_ids:
      cid = str(len(self.chara_ids))
      self.chara_ids[arg1] = cid
      display = self.getCharacter(arg1)
      entry = {"chara": arg1}
      if display != arg1:
        entry["nameText"] = display
      entry.update(self.officialNames(arg1))
      self.chara_meta[cid] = entry
    return self.chara_ids[arg1]

  def metaAttrs(self, pairs):
    """Render `data-*` attributes, skipping empties."""
    out = ''
    for key, value in pairs:
      if value is None or value == '': continue
      out += f' data-{key}="{escapeAttr(str(value))}"'
    return out

class HtmlSpecial(Html):

  def __init__(self, filename, args):
    super().__init__(filename, args)

  def dumpHtml(self):
    with open(self.filename + ".txt" + self.lang["suffix"], 'w', encoding='utf-8') as f:
      self.f = f
      self.dumpHtmlImpl()

  def dumpHtmlImpl(self):
    self.write(self.HEADER)
    for k in self.chapters:
      name = self.getName(k)
      words = self.countJpWords(self.chapters[k])
      self.write(f'<li><a href="#{name}">{name}</a> (~ {words} jp words)</li>')

    self.write('</ol>')

    for k in self.chapters:
      self.dumpScenario(self.getName(k), self.chapters[k])

  def dumpScenario(self, name, scenario):
    if self.valen_special:
      self.writeValenSpecialList(name, scenario)

    self.write(f'<h3 id="{name}">{name}</h3>')

    dialogue = self.lang["dialogue"]
    if_block = False
    count = 0
    min_underscore = self.countMinLabelUnderscore(name, scenario)

    for c in scenario:
      command = c.get("Command", "")
      if command == '':
        self.processLine(c, dialogue)
      elif command.startswith('*'):
        hash = self.processHash(command, "")
        if hash.count("_") == min_underscore:
          if count > 0: self.write('</textarea>')
          self.write(f'<div class="label" id="{hash}">Label: {hash}</div><textarea rows="80" cols="150">')
          count += 1

      elif command == 'TitleImage':
        episode = c["Arg1"]
        title = c["Arg2"]
        self.write(f'{episode} — {title}\n')

      elif command == 'Bg':
        self.write(f'【{c["Arg1"]}】\n')

      elif command == 'Selection':
        line = self.escapeLine(c[dialogue])
        self.write(f'> {line}')


    self.write('</textarea>')

  def processLine(self, c, dialogue):
    s = ''
    arg1 = c.get("Arg1", "")
    if arg1 != '':
      s += self.getTranslated(self.getCharacter(arg1))
      s += '：\n'

    if dialogue in c:
      s += self.escapeLine(c[dialogue])
      s += '\n'

    self.write(s)

  def escapeLine(self, s):
    return s.replace('、', '，').replace('――', '——').replace('ー', '—').replace('…', '…').replace("<param=playerName>", "主角").replace("<param=teamLeaderCharaName>", "《戀愛對象》")


def getBasename(filename):
  if filename.endswith(".json"):
    return filename[:-len(".json")]
  raise "file type unknown"

def forAllCwd(root, suffix, callback):
  root = os.path.abspath(root)
  files = next(os.walk(root))[2]

  for f in files:
    if f.endswith(suffix):
      callback(f)

def adaptJson(f):
  print(f)
  processBookJson(f)

HEADER = """<!DOCTYPE html><html>
<style>
table.diff {font-family:Consolas; border:medium;}
.diff_header {background-color:#e0e0e0}
td.diff_header {text-align:right}
.diff_next {background-color:#c0c0c0}
.diff_add {background-color:#aaffaa}
.diff_chg {background-color:#ffff77}
.diff_sub {background-color:#ffaaaa}
</style>
<body>
"""

FOOTER = """
<script>
/*trs = document.querySelectorAll("tr");

for (const tr of trs) {
  const first = tr.firstElementChild;
  const second = first.nextElementSibling;
  const third = second.nextElementSibling;

  tr.removeChild(first);
  tr.removeChild(second);
  tr.removeChild(third);

  tr.appendChild(first);
  tr.appendChild(second);
  tr.appendChild(third);

}*/
</script></body></html>"""

def compareHtml(oldVer, newVer, diffName):
  import difflib
  diff = difflib.HtmlDiff(wrapcolumn=80).make_table(oldVer, newVer, context=True)

  with open(diffName, "w", encoding="utf-8") as f:
    f.write(HEADER)
    f.writelines(diff)
    f.write(FOOTER)


def compareJson(oldJson, newJson, args):
  base = getBasename(oldJson)

  h1 = Html("", args)
  h1.chapters = processBookJson(oldJson)
  oldVer = h1.dumpHtml2Array()

  h2 = Html("", args)
  h2.chapters = processBookJson(newJson)
  newVer = h2.dumpHtml2Array()

  compareHtml(oldVer, newVer, base + ".diff.html")

def process_lang(value):
  map = {
    "en": {
      "name": "English",
      "dialogue": "English",
      "suffix": ".en.html",
      "sign_break": "*Signing noise*",
    },
    "cn": {
      "name": "ChineseSimplified",
      "dialogue": "ChineseSimplified",
      "suffix": ".cn.html",
      "sign_break": "*签字声*",
    },
    "tw": {
      "name": "ChineseTraditional",
      "dialogue": "ChineseTraditional",
      "suffix": ".tw.html",
      "sign_break": "*簽字聲*",
    },
    "jp": {
      "name": "Japanese",
      "dialogue": "Text",
      "suffix": ".html",
      "sign_break": "*サラサラ*",
    },
    "zh": {
      "name": "Chinese",
      "dialogue": "Chinese",
      "suffix": ".zh.html"
    }, # for eidos
  }
  if value not in map:
    raise argparse.ArgumentTypeError(f"{value} not one of {map.keys()}")
  return map[value]


def find_asset_key(obj, suffix):
  """Locate a top-level asset key by its trailing path segment.

  Different game builds prefix these paths differently (e.g.
  `Assets/Adv/Scenarios/common/localize/Localize.xls:Localize` vs.
  `Assets/Scene_Adv/Settings/common/Localize.xls:Localize`), so match on the
  suffix that's actually stable across builds instead of a hardcoded prefix.
  """
  matches = [key for key in obj if key.endswith(suffix)]
  if not matches:
    raise KeyError(f"No key ending with {suffix!r} found in common.chapter json")
  if len(matches) > 1:
    raise KeyError(f"Multiple keys ending with {suffix!r} found: {matches}")
  return obj[matches[0]]

def make_map(obj, lang):
  map = {}
  obj = find_asset_key(obj, "Localize.xls:Localize")
  k = lang["name"]

  for x in obj:
    if k in x:
      map.setdefault(x["Key"], x[k])
    #else:
    #  print(x)

  return map

def make_map2(obj):
  map = {}
  obj = find_asset_key(obj, "Character.xls:Character")

  for x in obj:
    if "CharacterName" in x and "NameText" in x:
      try:
        map.setdefault(x["CharacterName"], x["NameText"])
      except:
        print(x)
        raise

  return map

"""
Example:

From wiki server:	parse.py --download main11.book.json --source main main11.book.json
From local:		parse.py main10.book.json
Get common.chapter from wiki server:	parse.py --sync common .
Change output language:	parse.py --lang en valenjail2018_event.book.json
"""

if __name__ == "__main__":
  parser = argparse.ArgumentParser()
  parser.add_argument('--scan', action='store_true', help='Scan dir to convert raw json from AssetStudio to compact version')
  parser.add_argument('--source', default='event', choices=['event', 'main', 'chara', 'lesson', 'rinkai', 'dg01', 'dg02', 'dg03'])
  parser.add_argument('--compareV2', default='', help='Compare content V2')
  parser.add_argument('--lang', type=process_lang, default=process_lang("jp"), help='Language (jp, en, cn, tw)')
  parser.add_argument('--effecton', default=False, action='store_true', help='Keep effects')
  parser.add_argument('--greeting', type=str, help='Greeting file name')
  parser.add_argument('--sign', type=str, help='Sign file name')
  parser.add_argument('--special', action='store_true')
  parser.add_argument('--tl_name', action='store_true', help="Translate name")
  parser.add_argument('--no_tl_meta', dest='tl_meta', action='store_false',
                      help="Omit the data-* attributes the translation web app reads")
  parser.add_argument('--valentine', action='store_true')
  parser.add_argument('--no_newline', action='store_true')
  parser.add_argument('--common', type=str, default="common.chapter.json", help="path to common.chapter json")
  parser.add_argument('--skip', type=int, default=0, help="skip episodes")
  parser.add_argument('input', help='Input file name/directory')
  args = parser.parse_args()

  if args.scan:
    forAllCwd(args.input, ".book.json", adaptJson)
    sys.exit(0)

  if args.compareV2 != '':
    compareJson(args.compareV2, args.input, args)
    sys.exit(0)

  if args.sign:
    import glob

    obj = {}
    for filepath in sorted(glob.glob(os.path.join(args.input, "sign_*.json"))):
      h = Html(filepath, args)
      h.chapters = processBookJson(filepath)
      obj.update(h.process_sign())

    dumpJson(args.sign, obj)
    sys.exit(0)

  filename = args.input
  base = getBasename(filename)
  h = Html(base, args)
  h.chapters = processBookJson(filename)

  if args.greeting:
    h.process_greeting(args.greeting)
  elif args.special:
    h2 = HtmlSpecial(base, args)
    h2.chapters = h.chapters
    h2.dumpHtml()
  else:
    h.dumpHtml()