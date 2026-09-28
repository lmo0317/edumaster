using System.Text.RegularExpressions;

namespace EduMaster.Core;

public static class LearningStepConsolidator
{
    public static string[] Consolidate(IEnumerable<string> source, int maximum = ProblemDraft.MaxLogicSteps)
    {
        var steps=source.Select(step=>step?.Trim()??"").Where(step=>step.Length>0).ToArray();
        // Printed solutions often put an O/X choice review after the actual STEP sequence.
        // It applies the completed calculation to the choices; it is not another learning skill.
        while(steps.Length>ProblemDraft.MinLogicSteps&&IsChoiceReview(steps[^1]))steps=steps[..^1];
        if(steps.Length<=maximum)return steps;

        var grouped=new string[maximum];
        for(var group=0;group<maximum;group++){
            var start=group*steps.Length/maximum;
            var end=(group+1)*steps.Length/maximum;
            grouped[group]=string.Join(" -> ",steps[start..end]);
        }
        return grouped;
    }

    private static bool IsChoiceReview(string step)
    {
        var compact=Regex.Replace(step,@"\s+","");
        var explicitlyNamed=Regex.IsMatch(compact,@"^(?:선지|선택지|보기)(?:분석|판단|검토)");
        var markers=Regex.Matches(compact,@"[ㄱㄴㄷㄹ]").Select(m=>m.Value).Distinct().Count();
        var truthMarks=Regex.IsMatch(compact,@"\((?:O|X|○|×)\)|옳(?:다|지않)|참|거짓",RegexOptions.IgnoreCase);
        return explicitlyNamed||(markers>=2&&truthMarks);
    }

    public static string RelabelDetailedHeadings(string explanation)
        =>Regex.Replace(explanation,@"(?im)^\s*STEP\s+(\d+)\s*[.:·-]?\s*","세부 계산 $1. ");
}
