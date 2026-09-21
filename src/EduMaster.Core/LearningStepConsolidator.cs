using System.Text.RegularExpressions;

namespace EduMaster.Core;

public static class LearningStepConsolidator
{
    public static string[] Consolidate(IEnumerable<string> source, int maximum = ProblemDraft.MaxLogicSteps)
    {
        var steps=source.Select(step=>step?.Trim()??"").Where(step=>step.Length>0).ToArray();
        if(steps.Length<=maximum)return steps;

        var grouped=new string[maximum];
        for(var group=0;group<maximum;group++){
            var start=group*steps.Length/maximum;
            var end=(group+1)*steps.Length/maximum;
            grouped[group]=string.Join(" -> ",steps[start..end]);
        }
        return grouped;
    }

    public static string RelabelDetailedHeadings(string explanation)
        =>Regex.Replace(explanation,@"(?im)^\s*STEP\s+(\d+)\s*[.:·-]?\s*","세부 계산 $1. ");
}
