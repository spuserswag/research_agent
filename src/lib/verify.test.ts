/**
 * Tests for src/lib/verify.ts — the deterministic verifier port from
 * the Python prospect_brief pipeline. Each historical failure case
 * from the Python rollout is recreated here as a regression test.
 *
 * If any of these fail, a real-world brief regression is in flight.
 */

import { describe, it, expect } from "vitest";
import {
  normalize,
  quoteAppearsInSource,
  validateCompanyAttribute,
  validateLeadership,
  isSourceAboutCompany,
} from "./verify.js";

// ----------------------------------------------------------------------
// Normalize + substring
// ----------------------------------------------------------------------

describe("normalize", () => {
  it("lowercases, collapses whitespace, normalizes smart quotes", () => {
    expect(normalize("Hello   World")).toBe("hello world");
    expect(normalize("“smart” quotes")).toBe('"smart" quotes');
    expect(normalize("  \n\t  trimmed  ")).toBe("trimmed");
  });
});

describe("quoteAppearsInSource", () => {
  it("finds an exact substring match", () => {
    expect(
      quoteAppearsInSource(
        "founded in 1976",
        "Brantley Construction Company was founded in 1976 in Charleston.",
      ),
    ).toBe(true);
  });
  it("returns false for hallucinated quote not in source", () => {
    expect(
      quoteAppearsInSource(
        "we will acquire Monday.com next quarter",
        "Q4 revenue grew 9% year over year to $205.6 million.",
      ),
    ).toBe(false);
  });
  it("handles case + whitespace normalization", () => {
    expect(
      quoteAppearsInSource(
        "BUILDING SINCE 1976",
        "We've been building since 1976 in the Southeast.",
      ),
    ).toBe(true);
  });
});

// ----------------------------------------------------------------------
// validateCompanyAttribute — the QRC and Brantley historical bugs
// ----------------------------------------------------------------------

describe("validateCompanyAttribute — founded_year", () => {
  it("accepts a year paired with a founding-context word", () => {
    expect(
      validateCompanyAttribute("founded_year", "1976", "founded in 1976").ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute("founded_year", "1976", "Building since 1976").ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "founded_year",
        "2010",
        "established in 2010 in the Southeast",
      ).ok,
    ).toBe(true);
  });

  it("rejects QRC failure: founded 2021 from a LinkedIn employment date", () => {
    const { ok, reason } = validateCompanyAttribute(
      "founded_year",
      "2021",
      "May 2021 - Present",
    );
    expect(ok).toBe(false);
    expect(reason).toMatch(/founding-context/);
  });

  it("rejects QRC failure: founded 1983 from '40 years now' math hallucination", () => {
    const { ok } = validateCompanyAttribute(
      "founded_year",
      "1983",
      "40 years now",
    );
    expect(ok).toBe(false);
  });

  it("rejects license-issuance date misread as founding year", () => {
    const { ok } = validateCompanyAttribute(
      "founded_year",
      "2024",
      "license issued in 2024",
    );
    expect(ok).toBe(false);
  });
});

describe("validateCompanyAttribute — headquarters", () => {
  it("accepts HQ with a primary-location indicator", () => {
    expect(
      validateCompanyAttribute(
        "headquarters",
        "Charleston, SC",
        "headquartered in Charleston, SC",
      ).ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "headquarters",
        "Charleston, SC",
        "based in Charleston, South Carolina",
      ).ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "headquarters",
        "Charleston, SC",
        "corporate office located in Charleston, SC",
      ).ok,
    ).toBe(true);
  });

  it("rejects QRC failure: bare address-only quote as HQ", () => {
    const { ok, reason } = validateCompanyAttribute(
      "headquarters",
      "Charleston, SC",
      "975 Morrison Drive, Suite B, Charleston, SC 29403",
    );
    expect(ok).toBe(false);
    expect(reason).toMatch(/primary-location/);
  });

  it("rejects QRC failure: 'Asheville, NC' single line as HQ", () => {
    const { ok } = validateCompanyAttribute(
      "headquarters",
      "Asheville, NC",
      "Asheville, NC",
    );
    expect(ok).toBe(false);
  });

  it("rejects 'second office' as HQ — should be office_locations", () => {
    const { ok, reason } = validateCompanyAttribute(
      "headquarters",
      "Asheville, NC",
      "a second office in Asheville, NC",
    );
    expect(ok).toBe(false);
    expect(reason).toMatch(/secondary/);
  });
});

describe("validateCompanyAttribute — ownership_structure", () => {
  it("accepts family-owned / publicly traded / subsidiary forms", () => {
    expect(
      validateCompanyAttribute(
        "ownership_structure",
        "family-owned",
        "Family-owned and operated since 1976",
      ).ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "ownership_structure",
        "publicly traded",
        "publicly traded on NYSE under ticker ABC",
      ).ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "ownership_structure",
        "subsidiary of Acme Inc",
        "wholly owned subsidiary of Acme Inc",
      ).ok,
    ).toBe(true);
  });

  it("rejects QRC failure: bare 'Public Company' from LinkedIn UI metadata", () => {
    const { ok, reason } = validateCompanyAttribute(
      "ownership_structure",
      "Public Company",
      "Public Company",
    );
    expect(ok).toBe(false);
    // Either class-word or corroborator reason fires — both are correct
    expect(reason).toMatch(/class word|corroborator/);
  });
});

describe("validateCompanyAttribute — services_offered", () => {
  it("accepts a real service description", () => {
    expect(
      validateCompanyAttribute(
        "services_offered",
        "commercial general contractor",
        "commercial general contractors in the tri-county area",
      ).ok,
    ).toBe(true);
  });

  it("rejects QRC failure: PortalCam services with reseller pattern", () => {
    const { ok, reason } = validateCompanyAttribute(
      "services_offered",
      "PortalCam, scanning solutions",
      "supplies the PortalCam and other XGRIDS scanning solutions",
    );
    expect(ok).toBe(false);
    expect(reason).toMatch(/reseller|partner pattern/);
  });

  it("rejects Microsoft 365 services with 'resell' verb", () => {
    expect(
      validateCompanyAttribute(
        "services_offered",
        "Microsoft 365",
        "we resell Microsoft 365 licenses",
      ).ok,
    ).toBe(false);
  });

  it("rejects 'powered by IBM Watson' as services", () => {
    expect(
      validateCompanyAttribute(
        "services_offered",
        "IBM Watson",
        "powered by IBM Watson AI",
      ).ok,
    ).toBe(false);
  });

  it("rejects services value == company name (echoed brand)", () => {
    const { ok, reason } = validateCompanyAttribute(
      "services_offered",
      "Quantum Reality Capture",
      "Quantum Reality Capture is the brand name on file",
      "Quantum Reality Capture",
    );
    expect(ok).toBe(false);
    expect(reason).toMatch(/equals company name/);
  });
});

describe("validateCompanyAttribute — technology_stack (relaxed reseller rules)", () => {
  it("accepts third-party tools because that's the whole point of a tech stack", () => {
    expect(
      validateCompanyAttribute(
        "technology_stack",
        "AWS, Snowflake, dbt",
        "data infrastructure runs on AWS, Snowflake, and dbt",
      ).ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "technology_stack",
        "3D Gaussian Splatting, SLAM",
        "uses 3D Gaussian Splatting and SLAM-based scanning",
      ).ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "technology_stack",
        "XGRIDS PortalCam",
        "we operate the XGRIDS PortalCam in our scanning workflows",
      ).ok,
    ).toBe(true);
  });
});

describe("validateCompanyAttribute — federal IDs", () => {
  it("accepts well-formed CAGE / UEI / NAICS", () => {
    expect(validateCompanyAttribute("cage_code", "9DZZ0", "CAGE Code: 9DZZ0").ok).toBe(true);
    expect(
      validateCompanyAttribute("uei", "PM9THMDC1DV7", "UEI: PM9THMDC1DV7").ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "naics_codes",
        "236220",
        "NAICS 236220 — Commercial Building Construction",
      ).ok,
    ).toBe(true);
  });

  it("rejects malformed CAGE/UEI by length", () => {
    expect(validateCompanyAttribute("cage_code", "TOOLONG6", "code TOOLONG6").ok).toBe(false);
    expect(validateCompanyAttribute("uei", "TOOSHORT", "UEI: TOOSHORT").ok).toBe(false);
  });

  it("rejects QRC failure: SIC code 1542 misclassified as certification", () => {
    const { ok } = validateCompanyAttribute(
      "industry_certifications",
      "Construction",
      "1542",
    );
    expect(ok).toBe(false);
  });
});

describe("validateCompanyAttribute — operational_throughput", () => {
  it("requires both a number and a unit word", () => {
    expect(
      validateCompanyAttribute(
        "operational_throughput",
        "1,125 scans across 299 sites",
        "completed 1,125 scans across 299 sites",
      ).ok,
    ).toBe(true);
    expect(
      validateCompanyAttribute(
        "operational_throughput",
        "845M sq ft",
        "845 million square feet of building data captured",
      ).ok,
    ).toBe(true);
  });

  it("rejects a number without a unit word", () => {
    const { ok, reason } = validateCompanyAttribute(
      "operational_throughput",
      "1,125",
      "we have 1,125 of them",
    );
    expect(ok).toBe(false);
    expect(reason).toMatch(/unit word/);
  });

  it("rejects a unit word without a number", () => {
    expect(
      validateCompanyAttribute(
        "operational_throughput",
        "many scans",
        "completed many scans",
      ).ok,
    ).toBe(false);
  });

  it("rejects Brantley failure: 31 projects misread as headcount", () => {
    const { ok } = validateCompanyAttribute(
      "employee_count_range",
      "31",
      "Brantley Construction Company has worked on 31 permitted projects",
    );
    expect(ok).toBe(false);
  });
});

describe("validateCompanyAttribute — notable_clients (personal-history block)", () => {
  it("accepts a real client mention", () => {
    expect(
      validateCompanyAttribute(
        "notable_clients",
        "Volvo, Medical University",
        "projects for Volvo and the Medical University",
      ).ok,
    ).toBe(true);
  });

  it("rejects QRC failure: DroneLeaf as a 'founder of' personal-history quote", () => {
    const { ok, reason } = validateCompanyAttribute(
      "notable_clients",
      "DroneLeaf",
      "founder of DroneLeaf, an AI-driven robotics startup",
    );
    expect(ok).toBe(false);
    expect(reason).toMatch(/personal employment history/);
  });
});

// ----------------------------------------------------------------------
// validateLeadership — person-name-in-quote
// ----------------------------------------------------------------------

describe("validateLeadership", () => {
  const cases: Array<[string, string, string, boolean]> = [
    [
      "Christina McAlhaney",
      "Chief Estimator",
      "Christina McAlhaney, our Chief Estimator",
      true,
    ],
    [
      "Gary D Brantley",
      "PE",
      "Gary D Brantley, PE - Brantley Construction Company, LLC",
      true,
    ],
    // Nickname / prefix match: Daniel ↔ Dan
    [
      "Daniel Rogers",
      "CEO",
      "Asana picks Dan Rogers, formerly of ServiceNow, to replace CEO",
      true,
    ],
    // Bobby Brantley misattribution to Crowder Construction — DROP
    [
      "Bobby Brantley",
      "Business Development",
      "Business Development at Crowder Construction Company",
      false,
    ],
    // Dan Brantley to a different Brantley-named company — DROP
    [
      "Dan Brantley",
      "Owner",
      "Owner, Brantley Construction and Landscaping",
      false,
    ],
    // Sid Brantley with thin quote that doesn't name him — DROP
    [
      "Sid Brantley",
      "founder",
      "founder at Brantley Construction Company",
      false,
    ],
  ];

  it.each(cases)(
    "%s / %s / quote=%s → %s",
    (person, role, quote, expected) => {
      expect(validateLeadership(person, role, quote).ok).toBe(expected);
    },
  );
});

// ----------------------------------------------------------------------
// isSourceAboutCompany — relevance gate (CT Brantley impostor case)
// ----------------------------------------------------------------------

describe("isSourceAboutCompany — relevance gate", () => {
  const canonical = {
    id: "S1",
    url: "https://www.buildzoom.com/contractor/brantley-construction-company",
    title: "Brantley Construction Company",
    snippet:
      "Brantley Construction Company, headquartered in Charleston, SC, " +
      "specializes in commercial general contracting.",
  };
  const ctImpostor = {
    id: "S2",
    url: "https://www.buildzoom.com/contractor/brantley-construction-company-llc",
    title: "Brantley Construction Company LLC",
    snippet:
      "Brantley Construction Company LLC, 195 Glenn Dr, Stratford, CT — " +
      "Home Improvement Contractor license.",
  };

  it("trusts an exact seeded URL", () => {
    expect(
      isSourceAboutCompany(canonical, "Brantley Construction Company", {
        trustedUrls: [canonical.url],
      }).ok,
    ).toBe(true);
  });

  it("rejects the CT impostor when SC disambiguator is set", () => {
    const r = isSourceAboutCompany(ctImpostor, "Brantley Construction Company", {
      domain: "brantleyconstruction.com",
      disambiguators: ["charleston", "south carolina", "sc"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/impostor|disambiguator/);
  });

  it("keeps canonical source even when only domain (not phrase) is in URL", () => {
    const onlyDomainSrc = {
      id: "S3",
      url: "https://brantleyconstruction.com/about",
      title: "About",
      snippet: "Family-owned commercial general contractor in Charleston.",
    };
    expect(
      isSourceAboutCompany(onlyDomainSrc, "Brantley Construction Company", {
        domain: "brantleyconstruction.com",
        disambiguators: ["charleston"],
      }).ok,
    ).toBe(true);
  });

  it("drops a source that mentions company surname but not the full phrase", () => {
    const noiseSrc = {
      id: "S4",
      url: "https://www.yahoo.com/news/chick-fil-expansion.html",
      title: "Chick-fil-A expansion",
      snippet:
        "Mandy Brantley, senior area director for the Midwest, said the new stores will add 600 jobs.",
    };
    const r = isSourceAboutCompany(noiseSrc, "Brantley Construction Company", {
      domain: "brantleyconstruction.com",
      disambiguators: ["charleston"],
    });
    expect(r.ok).toBe(false);
  });

  it("LinkedIn /in/ profile passes when it mentions the company phrase", () => {
    const liProfile = {
      id: "S5",
      url: "https://www.linkedin.com/in/rob-brantley-0498198b",
      title: "Rob Brantley",
      snippet: "Rob Brantley · Senior VP at Brantley Construction Company",
    };
    expect(
      isSourceAboutCompany(liProfile, "Brantley Construction Company", {
        domain: "brantleyconstruction.com",
        disambiguators: ["charleston"],
      }).ok,
    ).toBe(true);
  });
});
