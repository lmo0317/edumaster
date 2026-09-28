using System.Text.RegularExpressions;

namespace EduMaster.Core;

/// <summary>
/// Catches literal contradictions between the generated problem and its explanation.
/// This intentionally checks only facts that can be compared without solving the problem.
/// </summary>
public static class ExplanationConsistencyCheck
{
    private static readonly Regex TableHeader = new(@"^\|\s*[^|]*\|(?<labels>(?:\s*[ⅠⅡⅢⅣⅤⅥIVX]+\s*\|)+)\s*$", RegexOptions.Compiled);
    private static readonly Regex TableRow = new(@"^\|\s*(?<series>[A-Za-z])\s*\|(?<values>.+)\|\s*$", RegexOptions.Compiled);
    private static readonly Regex GroupedVoltage = new(@"(?<series>[A-Za-z])(?:의|에서)\s*(?<labels>[ⅠⅡⅢⅣⅤⅥIVX\s,·와과]+?)(?:의\s*막전위)?\s*(?:은|는)\s*모두\s*(?<value>[+\-−]?\d+(?:\.\d+)?)\s*mV", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex ViewEquality = new(@"(?m)^\s*(?<marker>[ㄱ-ㅎ])\.\s*(?<lhs>[A-Za-z가-힣ⓐ-ⓩ₀-₉0-9_]+)\s*(?:은|는)\s*(?<value>[+\-−]?\d+(?:\.\d+)?)\s*(?<unit>ms|mV|cm|M|mol)\s*(?:이다|이다\.)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex ExplicitTruth = new(@"(?m)^\s*(?<marker>[ㄱ-ㄹ])\..*?\((?<truth>O|X|○|×)\)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static QualityCheck? Inspect(SampleResult result,bool compareAnswer=true)
    {
        var tableFacts = ParseTableFacts(result.Body);
        foreach(Match assertion in Regex.Matches(result.Body,@"(?m)^\s*(?<marker>[ㄱ-ㄹ])\.\s*(?<claim>[^\r\n]+?이다)[.。]?\s*$")){
            var marker=assertion.Groups["marker"].Value;
            var claim=assertion.Groups["claim"].Value.Trim();
            var proven=Regex.IsMatch(result.Explanation,@"(?:따라서|그러므로|즉)\s*"+Regex.Escape(claim));
            var rejected=Regex.IsMatch(result.Explanation,Regex.Escape(marker)+@"\s*(?:은|는)\s*(?:옳지\s*않|거짓|틀리)");
            if(proven&&rejected)return Fail($"해설이 '{claim}'라고 결론 낸 뒤 같은 보기 {marker}을 틀렸다고 판정합니다.");
        }
        foreach (Match claim in GroupedVoltage.Matches(result.Explanation))
        {
            var series = claim.Groups["series"].Value.ToUpperInvariant();
            var claimed = NormalizeNumber(claim.Groups["value"].Value);
            foreach (var label in ExtractLabels(claim.Groups["labels"].Value))
            {
                if (tableFacts.TryGetValue((series, label), out var actual) && actual != claimed)
                    return Fail($"문제 표에는 {series}의 {label}가 {actual}mV인데 해설은 {claimed}mV라고 설명합니다.");
            }
        }

        foreach (Match view in ViewEquality.Matches(result.Body))
        {
            var marker = Regex.Escape(view.Groups["marker"].Value);
            var lhs = Regex.Escape(view.Groups["lhs"].Value);
            var value = Regex.Escape(NormalizeNumber(view.Groups["value"].Value));
            var unit = Regex.Escape(view.Groups["unit"].Value);
            var derivedSameValue = Regex.IsMatch(result.Explanation, $@"{lhs}\s*=\s*{value}\s*{unit}", RegexOptions.IgnoreCase);
            var markedFalse = Regex.IsMatch(result.Explanation, $@"{marker}\s*(?:은|는).{{0,100}}?(?:옳지\s*않|거짓|틀리)", RegexOptions.Singleline);
            if (derivedSameValue && markedFalse)
                return Fail($"보기 {view.Groups["marker"].Value}의 '{view.Groups["lhs"].Value}={NormalizeNumber(view.Groups["value"].Value)}{view.Groups["unit"].Value}'를 해설이 그대로 계산한 뒤 틀렸다고 판정합니다.");
        }

        var viewMarkers=Regex.Matches(result.Body,@"(?m)^\s*(?<marker>[ㄱ-ㄹ])\.").Select(m=>m.Groups["marker"].Value).Distinct().ToArray();
        var judgments=ExplicitTruth.Matches(result.Explanation).Cast<Match>()
            .GroupBy(m=>m.Groups["marker"].Value)
            .ToDictionary(g=>g.Key,g=>g.Last().Groups["truth"].Value is "O" or "o" or "○");
        if(compareAnswer&&viewMarkers.Length>0&&viewMarkers.All(judgments.ContainsKey))
        {
            var explained=viewMarkers.Where(m=>judgments[m]).ToHashSet();
            var answered=Regex.Matches(Regex.Replace(result.Answer,@"^[①②③④⑤]\s*",""),@"[ㄱ-ㄹ]").Select(m=>m.Value).ToHashSet();
            if(!explained.SetEquals(answered))
                return Fail($"해설의 O/X 판정은 {FormatMarkers(explained)}인데 정답에는 {FormatMarkers(answered)}가 선택되어 서로 다릅니다.");
        }

        return tableFacts.Count == 0 && !ViewEquality.IsMatch(result.Body)
            ? null
            : new("explanation-consistency", "문제·해설 직접 대조", "pass", "표의 명시 수치와 보기의 명시 등식을 해설의 인용·판정과 대조했습니다.", "code-literal-consistency");
    }

    private static QualityCheck Fail(string evidence) => new("explanation-consistency", "문제·해설 직접 대조", "fail", evidence, "code-literal-consistency");

    private static Dictionary<(string Series, string Label), string> ParseTableFacts(string body)
    {
        var facts = new Dictionary<(string, string), string>();
        string[] labels = [];
        foreach (var raw in body.Split('\n'))
        {
            var line = raw.Trim();
            // Readers may omit the outside pipes or append handwritten point labels to headers.
            // Compare column values by the printed Roman labels, without accepting that mapping.
            if(line.Contains('|')){
                var cells=line.Trim('|').Split('|',StringSplitOptions.TrimEntries);
                var candidateLabels=cells.Skip(1).Select(c=>Regex.Match(c,@"^[ⅠⅡⅢⅣⅤⅥ]+|^(?:III|II|IV|VI|I|V)\b").Value).ToArray();
                if(cells.Length>1&&candidateLabels.All(c=>c.Length>0)){labels=candidateLabels;continue;}
                if(cells.Length>1&&Regex.IsMatch(cells[0],@"^[A-Za-z]$")&&labels.Length>0){
                    for(var i=0;i<Math.Min(labels.Length,cells.Length-1);i++)
                        if(Regex.IsMatch(cells[i+1],@"^[+\-−]?\d+(?:\.\d+)?$"))facts[(cells[0].ToUpperInvariant(),labels[i])]=NormalizeNumber(cells[i+1]);
                    continue;
                }
            }
            var header = TableHeader.Match(line);
            if (header.Success)
            {
                labels = ExtractLabels(header.Groups["labels"].Value).ToArray();
                continue;
            }
            var row = TableRow.Match(line);
            if (!row.Success || labels.Length == 0) continue;
            var values = row.Groups["values"].Value.Split('|', StringSplitOptions.TrimEntries);
            for (var i = 0; i < Math.Min(labels.Length, values.Length); i++)
            {
                var voltage = Regex.Match(values[i], @"^[+\-−]?\d+(?:\.\d+)?$");
                if (voltage.Success) facts[(row.Groups["series"].Value.ToUpperInvariant(), labels[i])] = NormalizeNumber(voltage.Value);
            }
        }
        return facts;
    }

    private static IEnumerable<string> ExtractLabels(string text) =>
        Regex.Matches(text, @"[ⅠⅡⅢⅣⅤⅥ]+|\b(?:I|II|III|IV|V|VI)\b", RegexOptions.IgnoreCase)
            .Select(m => m.Value.ToUpperInvariant());

    private static string NormalizeNumber(string value) => value.Replace('−', '-').TrimStart('+');
    private static string FormatMarkers(IEnumerable<string> markers){var value=string.Join(", ",markers);return value.Length==0?"없음":value;}
}
