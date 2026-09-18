//! The routing rules, in one place, each carrying where its number came from (spec 153 decisions
//! 8 and 9).
//!
//! These are the part most likely to be quietly reimplemented per flow with a slightly different
//! constant, and the cost of that is invisible: two flows disagreeing about what "confident" means
//! looks exactly like two flows disagreeing about the question. So a flow never writes a threshold
//! of its own — it names a gate here.
//!
//! **A threshold carries its provenance.** `~/nolf-improved/docs/jev-cookbooks.md` separates the
//! ones measured on this family of corpora from the ones lifted out of a cookbook and never
//! checked against anything here, and that distinction travels with the number: a value nobody
//! measured must not be quoted as though somebody had. `Threshold::provenance` is what a flow's
//! answer reports, so a person reading a judgement can see which kind they are looking at.

use serde_json::json;

/// Where a number came from, which is as much a part of it as its value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provenance {
    /// Measured on this family of corpora, with the measurement named.
    Measured(&'static str),
    /// Taken from the vendor's cookbook and NOT checked against anything here.
    Unvalidated(&'static str),
}

#[derive(Clone, Copy, Debug)]
pub struct Threshold {
    pub name: &'static str,
    pub value: f64,
    pub provenance: Provenance,
}

impl Threshold {
    pub fn report(&self) -> serde_json::Value {
        let (kind, note) = match self.provenance {
            Provenance::Measured(note) => ("measured", note),
            Provenance::Unvalidated(note) => ("unvalidated", note),
        };
        json!({ "name": self.name, "value": self.value, "provenance": kind, "note": note })
    }
}

/// A Choice below this answers "unsure" instead of naming a winner (`consistency_choice`).
///
/// NOT the cookbook's 0.90, which was derived on SEC filings. Measured on a 339-row known-issues
/// sweep run twice: the six matches that verify by hand came back at 0.78–0.99 and the two wrong
/// ones at 0.37 and 0.28, so any cut in (0.38, 0.78) separates them and this sits mid-gap.
pub const CONFIDENT: Threshold = Threshold {
    name: "confident",
    value: 0.60,
    provenance: Provenance::Measured(
        "a 339-row known-issues sweep run twice: hand-verified matches 0.78-0.99, wrong ones 0.37 and 0.28",
    ),
};

/// A Noul is read as a band rather than cut at 0.5 (`consistency_noul`).
///
/// A Noul near 0.5 means "similar probability either way", which is not the same as "medium", and
/// treating it as a midpoint invents a decision the answer did not make.
pub const NOUL_LOW: Threshold = Threshold {
    name: "noul_low",
    value: 0.30,
    provenance: Provenance::Measured("the band NOLF's own measurement put the cut at, rather than 0.5"),
};
pub const NOUL_HIGH: Threshold = Threshold { name: "noul_high", value: 0.70, ..NOUL_LOW };

/// Accept without a person (`citation_check`). Taken from the cookbook unchanged and **not**
/// validated here: `assert_check.py` has no labelled set behind it.
pub const AUTO_ACCEPT: Threshold = Threshold {
    name: "auto_accept",
    value: 0.80,
    provenance: Provenance::Unvalidated("citation_check's own value; no labelled set behind it here"),
};

/// Escalate to a person (`sde_cascade`). Cookbook value, unvalidated here for the same reason.
pub const ESCALATE: Threshold = Threshold {
    name: "escalate",
    value: 0.70,
    provenance: Provenance::Unvalidated("sde_cascade's own value; no labelled set behind it here"),
};

/// A candidate below this is noise (`prior-art`'s shortlist floor).
///
/// Measured: across six chunks the noise came in at or below 0.10 and every candidate a person
/// would want was 0.18 or above, so the floor sits in the gap between them.
pub const CANDIDATE_FLOOR: Threshold = Threshold {
    name: "candidate_floor",
    value: 0.15,
    provenance: Provenance::Measured("noise at or below 0.10, wanted candidates at 0.18 and above, over six chunks"),
};

/// An injection flag fires on a hard cut, not on the band.
///
/// Measured: the hostile string scores 0.99, while two genuine reports phrased as commands about
/// the subject — "fix the sky, the clouds move way too fast" — score 0.34 and 0.49. Under the band
/// both would have been announced as hostile, and a flag that cries wolf at ordinary reports is a
/// flag nobody reads.
pub const INJECTION: Threshold = Threshold {
    name: "injection",
    value: 0.70,
    provenance: Provenance::Measured("hostile string 0.99; two genuine reports phrased as commands 0.34 and 0.49"),
};

/// A date assembled below this goes to a person (`date_extraction`). Cookbook value.
pub const DATE_REVIEW: Threshold = Threshold {
    name: "date_review",
    value: 0.60,
    provenance: Provenance::Unvalidated("date_extraction's own REVIEW_BELOW"),
};

/// `skill_suggestion`'s two gates, both its own value.
pub const SKILL_WANTED: Threshold = Threshold {
    name: "skill_wanted",
    value: 0.30,
    provenance: Provenance::Unvalidated("skill_suggestion's own gate on whether any skill is wanted"),
};

/// How a Noul reads once it is a band rather than a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Band { No, Unsure, Yes }

impl Band {
    pub fn as_str(&self) -> &'static str {
        match self { Band::No => "no", Band::Unsure => "unsure", Band::Yes => "yes" }
    }
}

/// `consistency_noul`: below the low threshold is no, above the high is yes, and between them the
/// answer is that the question did not separate the two — not that the truth is halfway.
pub fn band(probability: f64) -> Band {
    if probability < NOUL_LOW.value { Band::No }
    else if probability > NOUL_HIGH.value { Band::Yes }
    else { Band::Unsure }
}

/// `consistency_choice`: a winner under the bar is not a winner. Returns `None` so a caller cannot
/// read an abstention as a quiet answer.
pub fn abstain(choice: &str, confidence: f64) -> Option<String> {
    (confidence >= CONFIDENT.value).then(|| choice.to_string())
}

/// `classification_using_confidence`: below the bar, say the broader thing you are still sure of
/// rather than the narrow thing you are not. `broader` maps a leaf to the level above it.
pub fn back_off<'a>(choice: &'a str, confidence: f64, broader: impl Fn(&str) -> Option<&'a str>)
                    -> (&'a str, bool) {
    if confidence >= CONFIDENT.value { return (choice, false); }
    match broader(choice) { Some(up) => (up, true), None => (choice, true) }
}

/// `sde_cascade`: questions framed so TRUE MEANS ESCALATE, aggregated with `max`.
///
/// Deliberately not a mean. One confident red flag is a flag; averaging it against three calm
/// questions is how a real one gets talked down.
pub fn escalates(probabilities: &[f64]) -> (bool, f64) {
    let worst = probabilities.iter().copied().fold(0.0_f64, f64::max);
    (worst >= ESCALATE.value, worst)
}

/// Every threshold, for a flow that reports the rules it ran under.
pub fn all() -> Vec<serde_json::Value> {
    [CONFIDENT, NOUL_LOW, NOUL_HIGH, AUTO_ACCEPT, ESCALATE, CANDIDATE_FLOOR, INJECTION, DATE_REVIEW,
     SKILL_WANTED].iter().map(Threshold::report).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_noul_between_the_thresholds_is_unsure_rather_than_halfway() {
        assert_eq!(band(0.02), Band::No);
        assert_eq!(band(0.50), Band::Unsure, "similar probability either way is not 'medium'");
        assert_eq!(band(0.99), Band::Yes);
        // The edges belong to unsure: a value AT the threshold has not cleared it.
        assert_eq!(band(NOUL_LOW.value), Band::Unsure);
        assert_eq!(band(NOUL_HIGH.value), Band::Unsure);
    }

    #[test]
    fn an_abstention_cannot_be_read_as_a_quiet_answer() {
        assert_eq!(abstain("F1294", 0.78).as_deref(), Some("F1294"));
        assert_eq!(abstain("F1294", 0.37), None, "under the bar there is no winner to return");
    }

    #[test]
    fn below_the_bar_the_broader_answer_is_given_instead() {
        let broader = |leaf: &str| if leaf == "F1294" { Some("renderer") } else { None };
        assert_eq!(back_off("F1294", 0.91, broader), ("F1294", false));
        assert_eq!(back_off("F1294", 0.41, broader), ("renderer", true), "name the category instead");
        // Nothing broader to back off to: the answer still reports that it was under the bar.
        assert_eq!(back_off("orphan", 0.41, broader), ("orphan", true));
    }

    #[test]
    fn one_confident_flag_is_a_flag_rather_than_an_average() {
        // The whole point of `max`: three calm questions must not talk one red flag down.
        assert_eq!(escalates(&[0.02, 0.01, 0.03, 0.95]), (true, 0.95));
        assert!(0.95_f64 / 4.0 < ESCALATE.value, "which a mean would have buried");
        assert_eq!(escalates(&[0.1, 0.2]), (false, 0.2));
        assert_eq!(escalates(&[]), (false, 0.0), "nothing asked is nothing to escalate");
    }

    #[test]
    fn a_threshold_says_whether_anyone_measured_it() {
        let measured = CONFIDENT.report();
        assert_eq!(measured["provenance"], "measured");
        assert!(measured["note"].as_str().expect("note").contains("339-row"));

        let taken = AUTO_ACCEPT.report();
        assert_eq!(taken["provenance"], "unvalidated",
                   "a cookbook's number must not be quoted as though somebody had checked it");
        assert_eq!(all().len(), 9, "every threshold is reportable, so none hides in a flow");
    }
}
