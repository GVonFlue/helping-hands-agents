// Owner-name parsing for seller lists ("SMITH JOHN A & MARY B", "John A Smith",
// "SMITH, JOHN") and a rough common-name test. The common lists are the most
// frequent US surnames (Census 2010) and given names (SSA); a name made of both
// is too common to match on name and city alone.

export type PersonName = { first: string; middle: string | null; last: string };

const SUFFIX = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const NOT_A_PERSON = /\b(TRUST|TRUSTEE|TRUSTEES|TR|ESTATE|EST|ETAL|ET AL|LLC|L L C|INC|CORP|CO|COMPANY|LP|LTD|PARTNERS|PARTNERSHIP|HOLDINGS|PROPERTIES|INVESTMENTS|REALTY|BANK|CHURCH|CITY OF|COUNTY|HOUSING|AUTHORITY|ASSOCIATION|ASSN|FOUNDATION|MINISTRIES|LIVING|REVOCABLE|FAMILY)\b/;

export const COMMON_LAST = new Set(
  (
    'SMITH JOHNSON WILLIAMS BROWN JONES GARCIA MILLER DAVIS RODRIGUEZ MARTINEZ HERNANDEZ LOPEZ GONZALEZ WILSON ANDERSON ' +
    'THOMAS TAYLOR MOORE JACKSON MARTIN LEE PEREZ THOMPSON WHITE HARRIS SANCHEZ CLARK RAMIREZ LEWIS ROBINSON WALKER YOUNG ' +
    'ALLEN KING WRIGHT SCOTT TORRES NGUYEN HILL FLORES GREEN ADAMS NELSON BAKER HALL RIVERA CAMPBELL MITCHELL CARTER ROBERTS ' +
    'GOMEZ PHILLIPS EVANS TURNER DIAZ PARKER CRUZ EDWARDS COLLINS REYES STEWART MORRIS MORALES MURPHY COOK ROGERS GUTIERREZ ' +
    'ORTIZ MORGAN COOPER PETERSON BAILEY REED KELLY HOWARD RAMOS KIM COX WARD RICHARDSON WATSON BROOKS CHAVEZ WOOD JAMES ' +
    'BENNETT GRAY MENDOZA RUIZ HUGHES PRICE ALVAREZ CASTILLO SANDERS PATEL MYERS LONG ROSS FOSTER JIMENEZ POWELL JENKINS ' +
    'PERRY RUSSELL SULLIVAN BELL COLEMAN BUTLER HENDERSON BARNES GONZALES FISHER VASQUEZ SIMMONS ROMERO JORDAN PATTERSON ' +
    'ALEXANDER HAMILTON GRAHAM REYNOLDS GRIFFIN WALLACE MORENO WEST COLE HAYES BRYANT HERRERA GIBSON ELLIS TRAN MEDINA ' +
    'AGUILAR STEVENS MURRAY FORD CASTRO MARSHALL OWENS HARRISON FERNANDEZ MCDONALD WOODS WASHINGTON KENNEDY WELLS VARGAS ' +
    'HENRY CHEN FREEMAN WEBB TUCKER GUZMAN BURNS CRAWFORD OLSON SIMPSON PORTER HUNTER GORDON MENDEZ SILVA SHAW SNYDER MASON ' +
    'DIXON MUNOZ HUNT HICKS HOLMES PALMER WAGNER BLACK ROBERTSON BOYD ROSE STONE SALAZAR FOX WARREN MILLS MEYER RICE SCHMIDT ' +
    'GARZA DANIELS FERGUSON NICHOLS STEPHENS SOTO WEAVER RYAN GARDNER PAYNE GRANT DUNN KELLEY SPENCER HAWKINS ARNOLD PIERCE ' +
    'VAZQUEZ HANSEN PETERS SANTOS HART BRADLEY KNIGHT ELLIOTT CUNNINGHAM DUNCAN ARMSTRONG HUDSON CARROLL LANE RILEY ANDREWS ' +
    'ALVARADO RAY DELGADO BERRY PERKINS HOFFMAN JOHNSTON MATTHEWS PENA RICHARDS CONTRERAS WILLIS CARPENTER LAWRENCE SANDOVAL'
  ).split(' '),
);

export const COMMON_FIRST = new Set(
  (
    'JAMES JOHN ROBERT MICHAEL WILLIAM DAVID RICHARD JOSEPH THOMAS CHARLES CHRISTOPHER DANIEL MATTHEW ANTHONY MARK DONALD ' +
    'STEVEN PAUL ANDREW JOSHUA KENNETH KEVIN BRIAN GEORGE TIMOTHY RONALD EDWARD JASON JEFFREY RYAN JACOB GARY NICHOLAS ERIC ' +
    'JONATHAN STEPHEN LARRY JUSTIN SCOTT BRANDON BENJAMIN SAMUEL GREGORY FRANK RAYMOND PATRICK JACK DENNIS JERRY TYLER AARON ' +
    'JOSE HENRY ADAM DOUGLAS NATHAN PETER ZACHARY KYLE WALTER HAROLD JEREMY ETHAN CARL KEITH ROGER GERALD CHRISTIAN TERRY ' +
    'SEAN ARTHUR AUSTIN NOAH LAWRENCE JESSE JOE BRYAN BILLY JORDAN ALBERT DYLAN BRUCE WILLIE GABRIEL ALAN JUAN LOGAN WAYNE ' +
    'RALPH ROY EUGENE RANDY VINCENT RUSSELL LOUIS PHILIP BOBBY JOHNNY BRADLEY MIKE BOB JIM BILL TOM DAN STEVE CHRIS DAVE ' +
    'MARY PATRICIA JENNIFER LINDA ELIZABETH BARBARA SUSAN JESSICA SARAH KAREN NANCY LISA BETTY MARGARET SANDRA ASHLEY ' +
    'KIMBERLY EMILY DONNA MICHELLE DOROTHY CAROL AMANDA MELISSA DEBORAH STEPHANIE REBECCA SHARON LAURA CYNTHIA KATHLEEN AMY ' +
    'SHIRLEY ANGELA HELEN ANNA BRENDA PAMELA NICOLE EMMA SAMANTHA KATHERINE CHRISTINE DEBRA RACHEL CAROLYN JANET CATHERINE ' +
    'MARIA HEATHER DIANE RUTH JULIE OLIVIA JOYCE VIRGINIA VICTORIA KELLY LAUREN CHRISTINA JOAN EVELYN JUDITH MEGAN ANDREA ' +
    'CHERYL HANNAH JACQUELINE MARTHA GLORIA TERESA ANN SARA MADISON FRANCES KATHRYN JANICE JEAN ABIGAIL ALICE JUDY SOPHIA ' +
    'GRACE DENISE AMBER DORIS MARILYN DANIELLE BEVERLY ISABELLA THERESA DIANA NATALIE BRITTANY CHARLOTTE MARIE KAYLA ALEXIS LORI'
  ).split(' '),
);

const NICKNAMES: Record<string, string[]> = {
  ROBERT: ['BOB', 'BOBBY', 'ROB', 'ROBBIE', 'BERT'], WILLIAM: ['BILL', 'BILLY', 'WILL', 'WILLIE', 'LIAM'],
  JAMES: ['JIM', 'JIMMY', 'JAMIE'], MICHAEL: ['MIKE', 'MIKEY', 'MICKEY'], RICHARD: ['RICK', 'RICH', 'DICK', 'RICKY'],
  JOSEPH: ['JOE', 'JOEY'], THOMAS: ['TOM', 'TOMMY'], CHARLES: ['CHUCK', 'CHARLIE'], CHRISTOPHER: ['CHRIS'],
  DANIEL: ['DAN', 'DANNY'], MATTHEW: ['MATT'], ANTHONY: ['TONY'], DONALD: ['DON', 'DONNIE'], STEVEN: ['STEVE'],
  STEPHEN: ['STEVE'], ANDREW: ['ANDY', 'DREW'], KENNETH: ['KEN', 'KENNY'], TIMOTHY: ['TIM'], RONALD: ['RON', 'RONNIE'],
  EDWARD: ['ED', 'EDDIE', 'TED'], JEFFREY: ['JEFF'], GREGORY: ['GREG'], NICHOLAS: ['NICK'], SAMUEL: ['SAM'],
  BENJAMIN: ['BEN'], DOUGLAS: ['DOUG'], GERALD: ['JERRY'], LAWRENCE: ['LARRY'], PATRICK: ['PAT'], RAYMOND: ['RAY'],
  ALBERT: ['AL'], DAVID: ['DAVE'], JONATHAN: ['JON'], JOHN: ['JACK', 'JOHNNY'], PHILIP: ['PHIL'], EUGENE: ['GENE'],
  ELIZABETH: ['LIZ', 'BETH', 'BETTY', 'LIZZY'], MARGARET: ['MAGGIE', 'PEGGY', 'MEG'], PATRICIA: ['PAT', 'PATTY', 'TRISH'],
  JENNIFER: ['JEN', 'JENNY'], KATHERINE: ['KATE', 'KATIE', 'KATHY'], CATHERINE: ['CATHY', 'KATE'], KATHLEEN: ['KATHY'],
  SUSAN: ['SUE', 'SUSIE'], DEBORAH: ['DEB', 'DEBBIE'], DEBRA: ['DEB', 'DEBBIE'], REBECCA: ['BECKY'], CYNTHIA: ['CINDY'],
  PAMELA: ['PAM'], SAMANTHA: ['SAM'], CHRISTINE: ['CHRIS', 'CHRISSY'], VICTORIA: ['VICKI', 'TORI'], JUDITH: ['JUDY'],
  BARBARA: ['BARB'], SANDRA: ['SANDY'], KIMBERLY: ['KIM'], ABIGAIL: ['ABBY'], DOROTHY: ['DOT', 'DOTTIE'],
};

export function firstNameVariants(first: string): Set<string> {
  const f = first.toUpperCase();
  const out = new Set([f]);
  for (const n of NICKNAMES[f] ?? []) out.add(n);
  for (const [formal, nicks] of Object.entries(NICKNAMES)) if (nicks.includes(f)) out.add(formal);
  return out;
}

function tokens(part: string): string[] {
  return part
    .toUpperCase()
    .replace(/[^A-Z\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t && !SUFFIX.has(t));
}

function onePerson(part: string, carryLast: string | null): PersonName | null {
  const raw = part.trim();
  if (!raw) return null;
  if (raw.includes(',')) {
    // "SMITH, JOHN A"
    const [lastPart, rest] = raw.split(',', 2) as [string, string];
    const last = tokens(lastPart).join(' ');
    const t = tokens(rest ?? '');
    if (!last || !t[0]) return null;
    return { first: t[0], middle: t[1] ?? null, last };
  }
  const t = tokens(raw);
  if (t.length === 1) return carryLast && t[0] ? { first: t[0], middle: null, last: carryLast } : null;
  if (t.length < 2) return null;
  // Second owner sharing the first's surname: "... & DIANE M"
  if (carryLast && t.length === 2 && t[1]!.length === 1) return { first: t[0]!, middle: t[1]!, last: carryLast };
  const a = t[0]!;
  const b = t[1]!;
  const z = t[t.length - 1]!;
  // County-style "LAST FIRST M": second token is a known given name and the first isn't,
  // or the final token is a lone middle initial.
  const lastFirst = (COMMON_FIRST.has(b) && !COMMON_FIRST.has(a)) || (z.length === 1 && t.length >= 3);
  if (lastFirst) return { first: b, middle: t[2] ?? null, last: a };
  return { first: a, middle: t.length > 2 ? t[1]! : null, last: z };
}

// Returns the people named on a list row, primary owner first. Empty when the
// owner is a trust, estate, company or otherwise not one person.
// `firstNameHint` = the list's own first-name column when it has one (Francis's
// vendor sends FULL NAME as "FIRST LAST" plus FIRST NAME); it settles the order.
export function parseOwnerName(ownerName: string | null | undefined, firstNameHint?: string | null): PersonName[] {
  if (!ownerName) return [];
  const upper = ownerName.toUpperCase();
  if (NOT_A_PERSON.test(upper)) return [];
  const parts = upper.split(/\s*(?:&|\bAND\b|\/|;)\s*/);
  const people: PersonName[] = [];
  const hint = tokens(firstNameHint ?? '')[0];
  for (const [i, part] of parts.entries()) {
    const t = tokens(part);
    if (i === 0 && hint && t.length >= 2 && t[0] === hint) {
      people.push({ first: hint, middle: t.length > 2 ? t[1]! : null, last: t[t.length - 1]! });
      continue;
    }
    const p = onePerson(part, people[0]?.last ?? null);
    if (p) people.push(p);
  }
  return people;
}

// The list's own first-name column, from the raw CSV row the CRM keeps.
export function firstNameFromRaw(raw: Record<string, unknown> | null | undefined): string | null {
  if (!raw) return null;
  for (const [k, v] of Object.entries(raw)) {
    if (/^(owner[\s_]*1?[\s_]*)?first[\s_]*name$/i.test(k.trim()) && typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function isCommonName(p: PersonName): boolean {
  return COMMON_LAST.has(p.last) && (COMMON_FIRST.has(p.first) || p.first.length <= 2);
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}
